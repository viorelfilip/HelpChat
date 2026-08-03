/**
 * Date demo pentru gestiunea facturilor. Rulează DOAR explicit:
 *   npm run seed:facturi            → refuză dacă există deja parteneri
 *   npm run seed:facturi -- --force → șterge datele din schema facturi și reia
 * Datele folosesc date calendaristice relative la ziua rulării, ca statisticile
 * și restanțele să aibă sens oricând.
 */
import { pool } from '../db/pool.js';
import { addPartner, createInvoice, registerPayment } from '../services/facturi/operations.js';

const force = process.argv.includes('--force');

function d(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${day}`;
}

const { rows: existing } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM facturi.partners');
if (existing[0].n > 0) {
  if (!force) {
    console.log(`Schema facturi conține deja ${existing[0].n} parteneri. Rulează cu --force pentru a înlocui datele demo.`);
    await pool.end();
    process.exit(0);
  }
  await pool.query('DELETE FROM facturi.payments');
  await pool.query('DELETE FROM facturi.invoices');
  await pool.query('DELETE FROM facturi.partners');
  console.log('Datele existente din schema facturi au fost șterse (--force).');
}

// Parteneri: un client, un furnizor și unul cu ambele roluri.
await addPartner({
  name: 'Alfa Software SRL',
  cui: 'RO14399840',
  is_client: true,
  email: 'facturare@alfasoftware.ro',
  city: 'Cluj-Napoca',
  iban: 'RO49AAAA1B31007593840000',
});
await addPartner({
  name: 'Birotica Total SRL',
  cui: '22334455',
  is_supplier: true,
  email: 'comenzi@biroticatotal.ro',
  city: 'București',
});
await addPartner({
  name: 'Construct Media SA',
  cui: 'RO987654',
  is_client: true,
  is_supplier: true,
  phone: '+40 21 555 0123',
  city: 'Timișoara',
});

// Facturi emise (de încasat).
await createInvoice({
  partner: 'Alfa Software SRL',
  direction: 'issued',
  series: 'INV',
  number: '2026-0101',
  issue_date: d(-40),
  due_date: d(-10),
  net_amount: 10_000,
  notes: 'Dezvoltare modul raportare — restantă, încasată parțial',
});
await createInvoice({
  partner: 'Alfa Software SRL',
  direction: 'issued',
  series: 'INV',
  number: '2026-0102',
  issue_date: d(-5),
  due_date: d(+25),
  net_amount: 4_200,
  notes: 'Mentenanță lunară',
});
await createInvoice({
  partner: 'Construct Media SA',
  direction: 'issued',
  series: 'INV',
  number: '2026-0103',
  issue_date: d(-20),
  due_date: d(+10),
  total_amount: 5_950,
  notes: 'Campanie promovare — încasată integral',
});

// Facturi primite (de plătit).
await createInvoice({
  partner: 'Birotica Total SRL',
  direction: 'received',
  series: 'BIR',
  number: '887',
  issue_date: d(-30),
  due_date: d(-5),
  net_amount: 1_500,
  notes: 'Consumabile birou — restantă',
});
await createInvoice({
  partner: 'Birotica Total SRL',
  direction: 'received',
  series: 'BIR',
  number: '900',
  issue_date: d(-10),
  due_date: d(+20),
  net_amount: 800,
  notes: 'Hârtie și tonere — plătită parțial',
});
await createInvoice({
  partner: 'Construct Media SA',
  direction: 'received',
  series: 'CM',
  number: '55',
  issue_date: d(-60),
  due_date: d(-30),
  net_amount: 2_000,
  notes: 'Chirie spațiu eveniment — achitată integral',
});

// Plăți și încasări (statusurile se recalculează automat).
await registerPayment({ series: 'INV', number: '2026-0101', amount: 5_950, payment_date: d(-15), reference: 'OP 1201' });
await registerPayment({ series: 'INV', number: '2026-0103', amount: 5_950, payment_date: d(-8), reference: 'OP 1214' });
await registerPayment({ series: 'BIR', number: '900', amount: 500, payment_date: d(-3), method: 'card' });
await registerPayment({ series: 'CM', number: '55', amount: 2_380, payment_date: d(-35), reference: 'OP 1180' });

const { rows: stats } = await pool.query<{ partners: number; invoices: number; payments: number }>(
  `SELECT (SELECT COUNT(*)::int FROM facturi.partners) AS partners,
          (SELECT COUNT(*)::int FROM facturi.invoices) AS invoices,
          (SELECT COUNT(*)::int FROM facturi.payments) AS payments`
);
console.log(
  `Seed complet: ${stats[0].partners} parteneri, ${stats[0].invoices} facturi, ${stats[0].payments} plăți/încasări.`
);
await pool.end();
