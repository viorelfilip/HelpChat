# Prompt: gestiune facturi și plăți, integrată în chat-ul RAG existent (tool-calling Ollama)

## Rol și obiectiv

Ești un inginer software senior care lucrează **în acest repo** (`practica2026`), un monorepo npm cu workspaces (`shared`, `backend`, `frontend`) — o aplicație RAG cu Fastify, PostgreSQL (pgvector) și modele Ollama locale. Extinde aplicația cu **gestiunea facturilor, plăților și partenerilor** unei firme din România, astfel încât **agentul de chat existent** (modelul Ollama din `CHAT_MODEL`) să poată răspunde la întrebări despre facturi și să opereze datele prin **function calling (tools)**.

**Nu construiești un server MCP și nu creezi un workspace nou.** Totul se integrează în backend-ul existent, iar singurul client este chat-ul aplicației (frontend → `POST /api/chat`).

Înainte de a scrie cod, citește obligatoriu aceste fișiere — ele definesc convențiile pe care le respecți:

- `backend/src/services/chat.ts` — orchestrarea RAG (`answerQuestion`, `SYSTEM_PROMPT`, citări)
- `backend/src/services/ollama.ts` — clientul Ollama (`chatStream`, `chat`, parsarea NDJSON)
- `backend/src/db/migrate.ts` și `backend/src/db/pool.ts` — runner-ul de migrări și `withTransaction`
- `backend/src/config.ts` — încărcarea și validarea configurației cu zod
- `backend/src/app.test.ts` și `backend/src/services/chat.test.ts` — cele două stiluri de teste
- `shared/src/index.ts` — tipurile partajate (`ChatStreamEvent`, `MessageRole`)

Mesajele de eroare, descrierile tool-urilor și comentariile din cod sunt **în limba română**, ca în restul repo-ului.

## Baza de date și migrări

- Se folosește conexiunea existentă (`DATABASE_URL`, pool-ul din `backend/src/db/pool.ts`). Nicio variabilă nouă de conexiune.
- **Nu atinge tabelele RAG existente** (`documents`, `document_versions`, `chunks`, `conversations`, `messages`, `media`, `ingestion_events`). Toate obiectele noi (tabele, enum-uri, indexuri, triggere) se creează într-o **schemă Postgres dedicată `facturi`**.
- Migrări: fișiere SQL noi, numerotate în continuarea celor existente din `backend/migrations/` (`005_facturi.sql`, apoi `006_…` dacă e nevoie), aplicate de **runner-ul existent** `backend/src/db/migrate.ts` — nu scrie alt runner. Rulările repetate nu strică nimic (runner-ul ține evidența în `schema_migrations`); pe o bază nouă, `npm run migrate` creează totul automat.
- Stilul SQL îl copiezi din `002_schema.sql`: comentariu explicativ sus, constrângeri CHECK inline, indexuri imediat după tabel.

## Model de date (schema `facturi`)

Sumele bănești se stochează ca `NUMERIC(14,2)` (niciodată float). Monedă implicită **RON**, cotă TVA implicită **19%**.

### `facturi.partners` — parteneri

Un partener poate fi **client, furnizor sau ambele**.

- `id` (PK), `name` (obligatoriu), `cui` (unic, obligatoriu — normalizat: fără prefix „RO", fără spații), `registration_number` (opțional)
- `is_client`, `is_supplier` (boolean, default false) — constrângere CHECK: cel puțin unul true
- `email`, `phone`, `address`, `city`, `country` (default 'România'), `iban` — opționale
- `created_at`, `updated_at` (timestamptz)

### `facturi.invoices` — facturi

Acoperă atât facturile **de încasat** (emise clienților) cât și cele **de plătit** (primite de la furnizori).

- `id` (PK), `partner_id` (FK → partners)
- `direction` (`'issued'` = de încasat / venit, `'received'` = de plătit / cheltuială)
- `series`, `number`, cu unicitate pe (`series`, `number`, `direction`)
- `issue_date`, `due_date`
- `currency` (default 'RON'), `vat_rate` (default 19.00)
- `net_amount` (bază impozabilă), `vat_amount`, `total_amount`
- `status` (`'draft'`, `'issued'`, `'partially_paid'`, `'paid'`, `'overdue'`, `'canceled'`)
- `notes`, `created_at`, `updated_at`

### `facturi.payments` — plăți / încasări

- `id` (PK), `invoice_id` (FK → invoices), `payment_date`, `amount`
- `method` (`'bank_transfer'`, `'cash'`, `'card'`, `'other'`)
- `reference` (nr. OP / detalii), `notes`, `created_at`

### Reguli de business

- Statusul facturii se **recalculează automat** din suma plăților (trigger în DB sau logică în cod — alege una și documenteaz-o): `paid` când plățile ≥ total, `partially_paid` când 0 < plăți < total, `overdue` când `due_date` a trecut și factura nu e integral plătită.
- Suma plăților unei facturi nu poate depăși `total_amount` (validare cu mesaj clar în română).
- Operațiile care creează/modifică bani rulează în tranzacție, cu `withTransaction` din `backend/src/db/pool.ts`.
- Indexuri pe `partner_id`, `due_date`, `status`, `direction`.
- Script `seed` (`npm run seed:facturi -w backend` sau similar) cu date demo românești: parteneri cu CUI plauzibil, facturi în ambele direcții, plăți parțiale. Rulează doar explicit, niciodată automat.

## Tool-uri pentru agentul de chat

Implementează tool-urile în `backend/src/services/facturi/`: fiecare cu **schemă zod** pentru argumente, descriere clară în română (modelul o folosește ca să aleagă tool-ul) și un **dispatcher** nume → funcție. Fiecare tool returnează un obiect JSON structurat plus un rezumat text scurt, pe care modelul îl folosește în răspunsul final.

### Interogare (statistici / rapoarte)

1. `list_invoices_to_pay` — facturi de plătit, neplătite/parțial plătite; filtre: partener, interval scadență, doar restante. → „Ce facturi am de plătit?"
2. `list_invoices_to_collect` — facturi de încasat, neîncasate/parțial. → „Ce facturi am de încasat?"
3. `get_expected_collections` — încasări așteptate pe o perioadă, după scadențe. → „Care este cuantumul încasărilor pentru luna viitoare?"
4. `get_balance` — balanța venituri vs cheltuieli pe o perioadă: facturat emis vs primit, încasat vs plătit, sold net. → „Care este balanța dintre venituri și cheltuieli?"
5. `get_statistics` — statistici pe perioadă: total facturi emise/primite, încasat, plătit, TVA colectată/deductibilă, restanțe, top parteneri.
6. `get_partner_statement` — fișa unui partener: facturi, plăți, sold curent.
7. `list_overdue_invoices` — toate facturile restante, ambele direcții.

**Perioade:** toate tool-urile de perioadă acceptă interval explicit (`from`/`to`, ISO) **sau** perioade relative: `last_two_weeks`, `last_month`, `last_year`, `next_month`, `current_month`, `year_to_date`. Implementează un **helper pur** (fără DB, ușor de testat) care le transformă în intervale concrete. Convenție: `last_month`/`last_year` = luna/anul **calendaristic** precedent; `last_two_weeks` = ultimele 14 zile. Documentează convenția în descrierile tool-urilor.

### Operare (scriere)

8. `add_partner` — minim `name` + `cui`. Dacă lipsesc date utile (tip client/furnizor, email, IBAN), tool-ul **nu inventează nimic** — returnează lista câmpurilor lipsă/recomandate, ca modelul să le ceară utilizatorului în conversație. → „Adaugă un partener cu numele X și CUI-ul Y."
9. `update_partner` — actualizează un partener existent.
10. `create_invoice` — creează factură emisă sau primită; calculează TVA și total din bază + cotă (sau invers, din total); validează existența partenerului.
11. `register_payment` — înregistrează plată/încasare pe o factură (identificată prin id sau serie+număr); statusul se actualizează.
12. `cancel_invoice` — anulează o factură (refuză dacă are plăți înregistrate, cu mesaj explicativ).

**Principii:** query-uri exclusiv parametrizate, validare zod + verificarea cheilor străine, erori acționabile în română returnate ca rezultat de tool (nu excepții brute — modelul trebuie să le poată explica utilizatorului), normalizare și unicitate CUI.

## Integrarea în pipeline-ul de chat (punctele exacte de modificat)

### `backend/src/services/ollama.ts`

- Extinde `chatStream()` să accepte opțional lista de `tools` (formatul nativ Ollama `/api/chat`) și să emită și `message.tool_calls`, nu doar `message.content`. Parserul NDJSON are deja obiectul JSON complet pe fiecare linie — azi doar restrânge tipul la `{ message?: { content?: string } }`.
- Extinde tipul `OllamaChatMessage`: rolul `'tool'` și câmpurile aferente (`tool_calls` pe assistant, `tool_name`/conținut pe tool — conform API-ului Ollama).
- **Caveat de verificat la implementare:** dacă versiunea de Ollama sau modelul curent nu suportă `stream: true` împreună cu `tools`, fă apelurile de decizie (cele care pot întoarce tool_calls) non-streaming prin `chat()`, și doar răspunsul final streaming prin `chatStream()`. Verifică comportamentul real cu `CHAT_MODEL`-ul din `.env` (gpt-oss:20b) înainte de a alege.

### `backend/src/services/chat.ts`

- `answerQuestion()` este deja `AsyncGenerator<ChatStreamEvent>` — adaugă bucla agentică: apel cu tools → dacă răspunsul conține `tool_calls`, execută-le prin dispatcher, adaugă în conversație mesajul assistant cu tool_calls + mesajele `role:'tool'` cu rezultatele, reapelează modelul → repetă până la un răspuns final fără tool_calls, cu **limită de iterații (ex. 5)** și mesaj clar dacă se atinge limita.
- Pipeline-ul RAG existent (retrieval hibrid, `contextBlock`, citări `[Sn]`) **rămâne neschimbat** pentru întrebările despre documente; tool-urile se oferă modelului în același apel, iar modelul alege singur când le folosește.
- **Critic — extinde `SYSTEM_PROMPT`:** regulile actuale („răspunzi doar din fragmente", refuzul cu fraza fixă „Informația nu se regăsește în documentele indexate.") se aplică **doar** întrebărilor despre documente. Pentru întrebări despre facturi, plăți, parteneri sau statistici financiare, modelul folosește tool-urile și răspunde pe baza rezultatelor lor, **fără** etichete `[Sn]` și fără refuzul standard. Fără această distincție, modelul va refuza toate întrebările de facturi.
- Mesajele `role:'tool'` și tool_calls **NU se persistă** în tabela `messages` (CHECK-ul actual pe `role` permite doar user/assistant și rămâne așa) — în istoric se salvează doar întrebarea user și răspunsul final assistant, ca acum.

### `shared/src/index.ts` și frontend

- Adaugă în `ChatStreamEvent` o variantă nouă, de ex. `{ type: 'tool'; name: string; summary: string }`, emisă când începe execuția unui tool, ca UI-ul să poată arăta „Consult facturile…".
- `frontend/src/api/client.ts` (`streamChat`) și `frontend/src/pages/Chat.tsx`: tratează noul tip de eveniment cu o afișare minimală (un indicator de progres/status în firul conversației). Nu schimba nimic altceva în UI.

### Config

- Dacă ai nevoie de parametri noi (ex. `TOOLS_MAX_ITERATIONS`), adaugă-i în `backend/src/config.ts` cu zod + default rezonabil și documentează-i în `.env.example`, în stilul comentariilor existente. Nu introduce flag-uri inutile.

## Prompturi pe care chat-ul aplicației trebuie să le acopere

- „Ce facturi am de plătit?" / „Ce facturi am de încasat?"
- „Care este cuantumul încasărilor pentru luna viitoare?"
- „Care este balanța dintre venituri și cheltuieli pe ultima lună?"
- „Dă-mi statistici pe ultimele două săptămâni / ultima lună / ultimul an."
- „Adaugă un partener cu numele X și CUI-ul Y." (+ cerere de date suplimentare dacă lipsesc)
- „Înregistrează o plată de 500 lei pentru factura INV-2026-0042."
- „Emite o factură către partenerul X, bază 1000 lei."
- Și, în continuare, întrebările RAG existente despre documente — fără regresii.

## Teste (vitest, după pattern-urile existente)

- **Unitare pure** (stil `chat.test.ts` / `retrieval.test.ts` — fără DB, fără mock-uri): calcul TVA/total, recalculare status factură, helper-ul de perioade relative, normalizare CUI, parsarea și dispatch-ul tool_calls (funcții pure extrase exact pentru testabilitate).
- **Integrare** (stil `app.test.ts` — DB real, `app.inject`, Ollama mock-uit): scenariu în care mock-ul `chatStream`/`chat` întoarce întâi un `tool_call` (ex. `list_invoices_to_pay`), apoi răspunsul final — verifică execuția tool-ului, evenimentele SSE (inclusiv `type: 'tool'`) și persistarea corectă a mesajelor. Atenție: `vi.mock('./services/ollama.js')` din `app.test.ts` este un **înlocuitor complet al modulului** — orice export nou din `ollama.ts` trebuie adăugat și în mock, altfel importul crapă. Testul își curăță singur datele create (pattern-ul existent).

## Criterii de acceptare

- `npm run migrate` pe o bază nouă creează schema `facturi` complet; a doua rulare raportează „nimic de aplicat". Tabelele RAG existente rămân neatinse.
- `npm test` trece integral (testele vechi + cele noi).
- Prin chat-ul aplicației (frontend sau `POST /api/chat`), prompturile de mai sus primesc răspunsuri corecte pe datele din seed.
- Întrebările RAG despre documente funcționează exact ca înainte (citări `[Sn]`, refuz când informația lipsește).

## Mod de lucru

1. Citește fișierele de referință enumerate la început, apoi propune schema SQL finală și structura din `backend/src/services/facturi/`; confirmă și continuă.
2. Implementează migrarea `005_facturi.sql`, apoi stratul de acces la date și regulile de business, cu testele unitare aferente.
3. Extinde `ollama.ts` (tools + tool_calls) și verifică pe modelul real comportamentul stream+tools.
4. Extinde `chat.ts` (bucla agentică + SYSTEM_PROMPT) și tipurile din `shared`, apoi frontend-ul minimal.
5. Scrie testele de integrare și rulează tot.
6. Actualizează `README.md` (secțiune scurtă: ce s-a adăugat, migrare, seed, exemple de prompturi) și `.env.example` dacă ai adăugat variabile.
7. La final: rezumat + pașii de verificare manuală.

Dacă o cerință e ambiguă, alege o convenție rezonabilă, menționeaz-o explicit și mergi mai departe — nu bloca lucrul cu întrebări inutile.
