## Rol și obiectiv

Ești un inginer software senior. Construiește-mi un proiect complet și funcțional pentru **gestiunea facturilor, plăților și partenerilor** unei firme din România, împreună cu un **server MCP (Model Context Protocol)** prin care pot interoga și opera datele folosind limbaj natural (prompturi).

Lucrează incremental: propune structura de directoare, creează fișierele, rulează migrările și scrie teste. La final dă-mi instrucțiuni clare de pornire.

## Stack tehnologic (obligatoriu)

- **Bază de date:** PostgreSQL (v15+).
- **Server MCP:** TypeScript / Node.js (v20+), folosind SDK-ul oficial `@modelcontextprotocol/sdk`.
- **Acces la DB:** driver `pg` (node-postgres) cu pool de conexiuni. Foloseste query-uri parametrizate (fără concatenare de SQL — prevenire SQL injection).
- **Migrări:** sistem de migrări versionat (folosește `node-pg-migrate` **sau** fișiere SQL numerotate rulate de un script propriu). Migrarea trebuie să ruleze **automat** la pornire pe o bază de date nouă (idempotent — creează tabele doar dacă nu există și înregistrează versiunile aplicate).
- **Config:** variabile de mediu prin `.env` (`DATABASE_URL` etc.), cu fișier `.env.example`.
- **Validare input:** `zod` pentru validarea argumentelor tool-urilor MCP.
- **Monedă și TVA:** implicit **RON**, cotă TVA implicită **19%**. Sumele bănești se stochează ca `NUMERIC(14,2)` (nu float). Fiecare factură are bază impozabilă, valoare TVA și total.

## Model de date (schema)

Creează cel puțin următoarele tabele. Poți ajusta/normaliza rezonabil, dar păstrează logica.

### `partners` (parteneri)
Un partener poate fi **client, furnizor sau ambele**.

- `id` (PK, UUID sau serial)
- `name` (text, obligatoriu)
- `cui` / `tax_id` (cod fiscal / CUI — text, unic, obligatoriu)
- `registration_number` (nr. Reg. Comerțului — opțional)
- `is_client` (boolean, default false)
- `is_supplier` (boolean, default false)
- `email`, `phone`, `address`, `city`, `country` (default 'România'), `iban` — opționale
- `created_at`, `updated_at` (timestamptz)

Constrângere: cel puțin unul dintre `is_client` / `is_supplier` trebuie să fie true.

### `invoices` (facturi)
Acoperă atât facturile **de încasat** (emise clienților), cât și cele **de plătit** (primite de la furnizori).

- `id` (PK)
- `partner_id` (FK → partners)
- `direction` (enum: `'issued'` = de încasat / venit, `'received'` = de plătit / cheltuială)
- `series`, `number` (serie și număr factură)
- `issue_date` (data emiterii), `due_date` (data scadenței)
- `currency` (default 'RON')
- `vat_rate` (NUMERIC, default 19.00)
- `net_amount` (bază impozabilă), `vat_amount` (TVA), `total_amount` (total cu TVA)
- `status` (enum: `'draft'`, `'issued'`, `'partially_paid'`, `'paid'`, `'overdue'`, `'canceled'`)
- `notes` (opțional)
- `created_at`, `updated_at`
- Constrângere de unicitate pe (`series`, `number`, `direction`).

### `payments` (plăți / încasări)
- `id` (PK)
- `invoice_id` (FK → invoices)
- `payment_date`
- `amount` (NUMERIC(14,2))
- `direction` (moștenit logic din factură: încasare vs plată)
- `method` (enum: `'bank_transfer'`, `'cash'`, `'card'`, `'other'`)
- `reference` (nr. OP / detalii), `notes`
- `created_at`

**Reguli de business:**
- `status`-ul facturii se recalculează automat pe baza sumei plăților (trigger în DB **sau** logică în cod): `paid` când suma plăților ≥ total, `partially_paid` când 0 < plăți < total, `overdue` când `due_date` a trecut și nu e plătită integral.
- Suma plăților asociate unei facturi nu trebuie să depășească totalul (validare).
- Include câteva **date demo (seed)** opționale, activabile printr-un flag, pentru testare.

Adaugă indexuri pe `partner_id`, `due_date`, `status`, `direction`.

## Server MCP — capabilități

Serverul MCP expune **tools** (acțiuni) prin care Claude poate răspunde la prompturi de interogare și de operare. Fiecare tool are schema `zod`, descriere clară în limba română și returnează rezultat structurat (JSON) + un rezumat text lizibil.

### Tools de interogare (statistici / rapoarte)

1. `list_invoices_to_pay` — facturile **de plătit** (direction = received), neplătite/parțial plătite. Suportă filtre: partener, interval scadență, doar restante. → răspunde la *„Ce facturi am de plătit?”*
2. `list_invoices_to_collect` — facturile **de încasat** (direction = issued), neîncasate/parțial. → *„Ce facturi am de încasat?”*
3. `get_expected_collections` — cuantumul încasărilor așteptate pe o perioadă (ex. luna viitoare), pe baza scadențelor facturilor emise neîncasate. → *„Care este cuantumul încasărilor pentru luna viitoare?”*
4. `get_balance` — balanța venituri vs cheltuieli pe o perioadă: total facturat emis vs primit, total încasat vs plătit, sold net. → *„Care este balanța dintre venituri și cheltuieli?”*
5. `get_statistics` — statistici generale pe o **perioadă** parametrizată. Acceptă atât interval explicit (`from`/`to`) cât și perioade relative predefinite: `last_two_weeks`, `last_month`, `last_year`, `next_month`, `current_month`, `year_to_date`. Returnează: total facturi emise/primite, încasat, plătit, TVA colectată/deductibilă, restanțe, top parteneri.
6. `get_partner_statement` — fișa unui partener: facturi, plăți, sold curent (cât îmi datorează / cât îi datorez).
7. `list_overdue_invoices` — toate facturile restante (scadență depășită), în ambele direcții.

> Pentru toate tool-urile de perioadă, implementează un helper care transformă perioadele relative în intervale de date concrete, raportate la data curentă. Documentează clar cum sunt calculate („ultima lună” = ultimele 30 de zile vs luna calendaristică precedentă — alege și menționează convenția; recomand: luna/anul **calendaristic** precedent, iar „ultimele două săptămâni” = ultimele 14 zile).

### Tools de operare (scriere în DB)

8. `add_partner` — adaugă un partener. Argument minim: `name` și `cui`. Dacă lipsesc informații necesare, tool-ul **NU inventează** date — returnează un mesaj care indică ce câmpuri suplimentare sunt necesare/recomandate (ex. tip: client/furnizor, email, IBAN), astfel încât Claude să le ceară utilizatorului. → *„Adaugă un partener cu numele și CUI-ul specificate.”*
9. `update_partner` — actualizează datele unui partener.
10. `create_invoice` — creează o factură (emisă sau primită). Calculează automat TVA și total din bază + cotă (sau din total, după caz). Validează existența partenerului.
11. `register_payment` — înregistrează o plată/încasare pentru o factură; actualizează statusul facturii.
12. `update_invoice_status` / `cancel_invoice` — modifică/anulează o factură.

**Principii pentru tool-urile de scriere:**
- Validează întotdeauna inputul cu `zod` și existența cheilor străine.
- Returnează erori clare și acționabile (în română), nu excepții brute.
- Pentru CUI, normalizează (elimină prefix „RO”, spații) și verifică unicitatea.
- Operațiile care creează/modifică bani rulează în tranzacție.

## Fluxuri de tip prompt pe care sistemul trebuie să le suporte

Asigură-te că, prin tool-urile de mai sus, un utilizator poate obține răspuns natural la:

- „Ce facturi am de plătit?” / „Ce facturi am de încasat?”
- „Care este cuantumul încasărilor pentru luna viitoare?”
- „Care este balanța dintre venituri și cheltuieli?” (pe o perioadă)
- „Dă-mi statistici pe ultimele două săptămâni / ultima lună / ultimul an.”
- „Adaugă un partener cu numele X și CUI-ul Y.” (și cererea de date suplimentare dacă lipsesc)
- „Înregistrează o plată de N lei pentru factura seria/nr Z.”
- „Emite o factură către partenerul X, bază 1000 lei.”

## Migrări automate

- La pornirea serverului (sau printr-un script `npm run migrate`), sistemul verifică baza de date și **aplică automat migrările lipsă** pe o bază nouă (creează tabele, enum-uri, indexuri, triggere, tabela de evidență a migrărilor).
- Migrările sunt **idempotente** și versionate; rularea repetată nu strică nimic.
- Documentează comanda de setup pentru o bază de date complet nouă.

## Cerințe de livrare

1. Structură de proiect curată (`src/`, `migrations/`, `src/mcp/tools/`, `src/db/`, etc.).
2. `package.json` cu scripturi: `dev`, `build`, `start`, `migrate`, `seed`, `test`.
3. `.env.example` și un `README.md` cu: cerințe, pași de instalare, cum pornesc PostgreSQL (inclusiv exemplu `docker-compose.yml` pentru Postgres), cum rulez migrarea, cum conectez serverul MCP la Claude (fragment de config `claude_desktop_config.json` / `.mcp.json`).
4. **Teste** (Vitest sau Jest) pentru: calcul TVA/total, recalculare status factură, helper-ul de perioade relative, și cel puțin un tool de interogare și unul de operare.
5. Cod TypeScript strict (`strict: true`), tipuri clare, fără `any` nejustificat.
6. Tratare de erori și logare.

## Mod de lucru

1. Începe prin a-mi propune structura de directoare și schema finală, apoi confirmă și continuă.
2. Implementează migrările și schema DB.
3. Implementează stratul de acces la date și logica de business.
4. Implementează serverul MCP și tool-urile.
5. Scrie testele și rulează-le.
6. Scrie README-ul și fragmentul de configurare MCP.
7. La final, rezumă ce ai construit și cum îl pornesc.

Dacă vreo cerință e ambiguă, alege o convenție rezonabilă, menționeaz-o explicit și continuă — nu bloca lucrul cu întrebări inutile.
