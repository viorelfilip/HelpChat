/**
 * Acces la date pentru schema `facturi`. Toate query-urile sunt parametrizate;
 * operațiile care modifică bani rulează în tranzacție (withTransaction).
 * Sumele NUMERIC se citesc cu ::float8 — la scara NUMERIC(14,2) conversia
 * este exactă pentru valori uzuale de facturare.
 */
import type pg from 'pg';
import { pool, withTransaction } from '../../db/pool.js';
import { computeAmounts, computeInvoiceStatus, normalizeCui, round2 } from './calc.js';
import type { InvoiceDirection, InvoiceStatus } from './calc.js';
import { todayIso, type DateRange } from './perioade.js';

export interface PartnerRow {
  id: number;
  name: string;
  cui: string;
  registration_number: string | null;
  is_client: boolean;
  is_supplier: boolean;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string;
  iban: string | null;
}

export interface InvoiceRow {
  id: number;
  partner_id: number;
  partner_name: string;
  partner_cui: string;
  direction: InvoiceDirection;
  series: string;
  number: string;
  issue_date: string;
  due_date: string;
  currency: string;
  vat_rate: number;
  net_amount: number;
  vat_amount: number;
  total_amount: number;
  paid_amount: number;
  remaining_amount: number;
  status: InvoiceStatus;
  /** Statusul cu `overdue` derivat la zi (scadența poate fi depășită după ultima scriere). */
  effective_status: InvoiceStatus;
  notes: string | null;
}

const PARTNER_COLUMNS = `id, name, cui, registration_number, is_client, is_supplier,
  email, phone, address, city, country, iban`;

const INVOICE_SELECT = `
  SELECT i.id, i.partner_id, p.name AS partner_name, p.cui AS partner_cui,
         i.direction, i.series, i.number,
         i.issue_date::text AS issue_date, i.due_date::text AS due_date,
         i.currency, i.vat_rate::float8 AS vat_rate,
         i.net_amount::float8 AS net_amount, i.vat_amount::float8 AS vat_amount,
         i.total_amount::float8 AS total_amount,
         COALESCE(pay.paid, 0)::float8 AS paid_amount,
         i.status, i.notes
  FROM facturi.invoices i
  JOIN facturi.partners p ON p.id = i.partner_id
  LEFT JOIN (
    SELECT invoice_id, SUM(amount) AS paid FROM facturi.payments GROUP BY invoice_id
  ) pay ON pay.invoice_id = i.id`;

function mapInvoice(row: Omit<InvoiceRow, 'remaining_amount' | 'effective_status'>, today: string): InvoiceRow {
  const remaining = round2(row.total_amount - row.paid_amount);
  return {
    ...row,
    remaining_amount: remaining,
    effective_status: computeInvoiceStatus({
      totalAmount: row.total_amount,
      paidAmount: row.paid_amount,
      dueDate: row.due_date,
      currentStatus: row.status,
      today,
    }),
  };
}

/**
 * Găsește un partener după CUI (exact, normalizat) sau nume (căutare parțială,
 * fără diacritice stricte). Eroare descriptivă la 0 sau la mai multe potriviri.
 */
export async function findPartner(ref: string): Promise<PartnerRow> {
  let byCui: PartnerRow | undefined;
  try {
    const cui = normalizeCui(ref);
    const { rows } = await pool.query<PartnerRow>(
      `SELECT ${PARTNER_COLUMNS} FROM facturi.partners WHERE cui = $1`,
      [cui]
    );
    byCui = rows[0];
  } catch {
    // ref nu arată a CUI — căutăm după nume
  }
  if (byCui) return byCui;

  const { rows } = await pool.query<PartnerRow>(
    `SELECT ${PARTNER_COLUMNS} FROM facturi.partners WHERE name ILIKE $1 ORDER BY name LIMIT 5`,
    [`%${ref}%`]
  );
  if (rows.length === 0) {
    throw new Error(`Nu am găsit niciun partener pentru "${ref}". Verifică numele sau CUI-ul.`);
  }
  if (rows.length > 1) {
    const names = rows.map((r) => `${r.name} (CUI ${r.cui})`).join(', ');
    throw new Error(`"${ref}" se potrivește cu mai mulți parteneri: ${names}. Precizează CUI-ul.`);
  }
  return rows[0];
}

/** Găsește o factură după id sau după serie + număr (+ direcție, dacă e ambiguu). */
export async function findInvoice(ref: {
  invoice_id?: number;
  series?: string;
  number?: string;
  direction?: InvoiceDirection;
}): Promise<InvoiceRow> {
  const today = todayIso();
  if (ref.invoice_id !== undefined) {
    const { rows } = await pool.query(`${INVOICE_SELECT} WHERE i.id = $1`, [ref.invoice_id]);
    if (rows.length === 0) throw new Error(`Nu există factura cu id ${ref.invoice_id}.`);
    return mapInvoice(rows[0], today);
  }
  if (!ref.series || !ref.number) {
    throw new Error('Identifică factura prin invoice_id sau prin serie + număr (series, number).');
  }
  const params: unknown[] = [ref.series, ref.number];
  let where = `WHERE i.series ILIKE $1 AND i.number = $2`;
  if (ref.direction) {
    params.push(ref.direction);
    where += ` AND i.direction = $3`;
  }
  const { rows } = await pool.query(`${INVOICE_SELECT} ${where}`, params);
  if (rows.length === 0) {
    throw new Error(`Nu am găsit factura ${ref.series} ${ref.number}.`);
  }
  if (rows.length > 1) {
    throw new Error(
      `Există atât o factură emisă, cât și una primită cu seria/numărul ${ref.series} ${ref.number}. ` +
        `Precizează direcția: issued (emisă) sau received (primită).`
    );
  }
  return mapInvoice(rows[0], today);
}

export interface OpenInvoiceFilters {
  partner?: string;
  due_from?: string;
  due_to?: string;
  overdue_only?: boolean;
}

/** Facturile deschise (neplătite integral) pe o direcție, cu filtre opționale. */
export async function listOpenInvoices(direction: InvoiceDirection, filters: OpenInvoiceFilters = {}): Promise<InvoiceRow[]> {
  const today = todayIso();
  const params: unknown[] = [direction];
  const where: string[] = [`i.direction = $1`, `i.status NOT IN ('paid', 'canceled', 'draft')`];

  if (filters.partner) {
    const partner = await findPartner(filters.partner);
    params.push(partner.id);
    where.push(`i.partner_id = $${params.length}`);
  }
  if (filters.due_from) {
    params.push(filters.due_from);
    where.push(`i.due_date >= $${params.length}`);
  }
  if (filters.due_to) {
    params.push(filters.due_to);
    where.push(`i.due_date <= $${params.length}`);
  }
  if (filters.overdue_only) {
    where.push(`i.due_date < CURRENT_DATE`);
  }

  const { rows } = await pool.query(`${INVOICE_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.due_date, i.id`, params);
  return rows.map((r) => mapInvoice(r, today));
}

/** Toate facturile restante (scadență depășită, neplătite integral), ambele direcții. */
export async function listOverdueInvoices(): Promise<InvoiceRow[]> {
  const today = todayIso();
  const { rows } = await pool.query(
    `${INVOICE_SELECT}
     WHERE i.status NOT IN ('paid', 'canceled', 'draft') AND i.due_date < CURRENT_DATE
     ORDER BY i.due_date, i.id`
  );
  return rows.map((r) => mapInvoice(r, today));
}

/** Încasările așteptate într-o perioadă, după scadențele facturilor emise neîncasate. */
export async function getExpectedCollections(range: DateRange): Promise<{ expected: number; invoices: InvoiceRow[] }> {
  const invoices = await listOpenInvoices('issued', { due_from: range.from, due_to: range.to });
  const expected = round2(invoices.reduce((sum, i) => sum + i.remaining_amount, 0));
  return { expected, invoices };
}

export interface BalanceReport {
  range: DateRange;
  invoiced_issued: number;
  invoiced_received: number;
  invoiced_net: number;
  collected: number;
  paid: number;
  cash_net: number;
}

/** Balanța venituri vs cheltuieli: facturat (după data emiterii) și fluxuri de bani (după data plății). */
export async function getBalance(range: DateRange): Promise<BalanceReport> {
  const { rows } = await pool.query<{
    invoiced_issued: number;
    invoiced_received: number;
    collected: number;
    paid: number;
  }>(
    `SELECT
       (SELECT COALESCE(SUM(total_amount), 0)::float8 FROM facturi.invoices
         WHERE direction = 'issued' AND status NOT IN ('canceled', 'draft') AND issue_date BETWEEN $1 AND $2) AS invoiced_issued,
       (SELECT COALESCE(SUM(total_amount), 0)::float8 FROM facturi.invoices
         WHERE direction = 'received' AND status NOT IN ('canceled', 'draft') AND issue_date BETWEEN $1 AND $2) AS invoiced_received,
       (SELECT COALESCE(SUM(pay.amount), 0)::float8 FROM facturi.payments pay
         JOIN facturi.invoices i ON i.id = pay.invoice_id
         WHERE i.direction = 'issued' AND pay.payment_date BETWEEN $1 AND $2) AS collected,
       (SELECT COALESCE(SUM(pay.amount), 0)::float8 FROM facturi.payments pay
         JOIN facturi.invoices i ON i.id = pay.invoice_id
         WHERE i.direction = 'received' AND pay.payment_date BETWEEN $1 AND $2) AS paid`,
    [range.from, range.to]
  );
  const r = rows[0];
  return {
    range,
    ...r,
    invoiced_net: round2(r.invoiced_issued - r.invoiced_received),
    cash_net: round2(r.collected - r.paid),
  };
}

export interface StatisticsReport extends BalanceReport {
  count_issued: number;
  count_received: number;
  vat_collected: number;
  vat_deductible: number;
  overdue_count: number;
  overdue_amount: number;
  top_partners: Array<{ name: string; cui: string; direction: InvoiceDirection; total: number }>;
}

/** Statistici pe o perioadă: volume facturate, fluxuri, TVA, restanțe la zi, top parteneri. */
export async function getStatistics(range: DateRange): Promise<StatisticsReport> {
  const balance = await getBalance(range);

  const { rows: countRows } = await pool.query<{
    count_issued: number;
    count_received: number;
    vat_collected: number;
    vat_deductible: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE direction = 'issued')::float8 AS count_issued,
       COUNT(*) FILTER (WHERE direction = 'received')::float8 AS count_received,
       COALESCE(SUM(vat_amount) FILTER (WHERE direction = 'issued'), 0)::float8 AS vat_collected,
       COALESCE(SUM(vat_amount) FILTER (WHERE direction = 'received'), 0)::float8 AS vat_deductible
     FROM facturi.invoices
     WHERE status NOT IN ('canceled', 'draft') AND issue_date BETWEEN $1 AND $2`,
    [range.from, range.to]
  );

  // Restanțele sunt o fotografie la zi, nu pe perioadă.
  const overdue = await listOverdueInvoices();

  const { rows: topRows } = await pool.query<{ name: string; cui: string; direction: InvoiceDirection; total: number }>(
    `SELECT p.name, p.cui, i.direction, SUM(i.total_amount)::float8 AS total
     FROM facturi.invoices i
     JOIN facturi.partners p ON p.id = i.partner_id
     WHERE i.status NOT IN ('canceled', 'draft') AND i.issue_date BETWEEN $1 AND $2
     GROUP BY p.name, p.cui, i.direction
     ORDER BY total DESC
     LIMIT 5`,
    [range.from, range.to]
  );

  return {
    ...balance,
    ...countRows[0],
    overdue_count: overdue.length,
    overdue_amount: round2(overdue.reduce((sum, i) => sum + i.remaining_amount, 0)),
    top_partners: topRows,
  };
}

export interface PartnerStatement {
  partner: PartnerRow;
  invoices: InvoiceRow[];
  /** Cât ne datorează partenerul (rest pe facturile emise către el). */
  they_owe_us: number;
  /** Cât îi datorăm (rest pe facturile primite de la el). */
  we_owe_them: number;
}

/** Fișa unui partener: toate facturile, cu solduri pe ambele direcții. */
export async function getPartnerStatement(ref: string): Promise<PartnerStatement> {
  const partner = await findPartner(ref);
  const today = todayIso();
  const { rows } = await pool.query(
    `${INVOICE_SELECT} WHERE i.partner_id = $1 ORDER BY i.issue_date DESC, i.id DESC`,
    [partner.id]
  );
  const invoices = rows.map((r) => mapInvoice(r, today));
  const open = invoices.filter((i) => i.status !== 'canceled' && i.status !== 'draft');
  return {
    partner,
    invoices,
    they_owe_us: round2(open.filter((i) => i.direction === 'issued').reduce((s, i) => s + i.remaining_amount, 0)),
    we_owe_them: round2(open.filter((i) => i.direction === 'received').reduce((s, i) => s + i.remaining_amount, 0)),
  };
}

export interface AddPartnerInput {
  name: string;
  cui: string;
  is_client?: boolean;
  is_supplier?: boolean;
  registration_number?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  iban?: string;
}

export async function addPartner(input: AddPartnerInput): Promise<PartnerRow> {
  const cui = normalizeCui(input.cui);
  try {
    const { rows } = await pool.query<PartnerRow>(
      `INSERT INTO facturi.partners
         (name, cui, registration_number, is_client, is_supplier, email, phone, address, city, country, iban)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'România'), $11)
       RETURNING ${PARTNER_COLUMNS}`,
      [
        input.name,
        cui,
        input.registration_number ?? null,
        input.is_client ?? false,
        input.is_supplier ?? false,
        input.email ?? null,
        input.phone ?? null,
        input.address ?? null,
        input.city ?? null,
        input.country ?? null,
        input.iban ?? null,
      ]
    );
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new Error(`Există deja un partener cu CUI ${cui}. Folosește update_partner pentru modificări.`);
    }
    throw err;
  }
}

const PARTNER_UPDATABLE = [
  'name',
  'registration_number',
  'is_client',
  'is_supplier',
  'email',
  'phone',
  'address',
  'city',
  'country',
  'iban',
] as const;

export async function updatePartner(
  ref: string,
  fields: Partial<Record<(typeof PARTNER_UPDATABLE)[number], unknown>>
): Promise<PartnerRow> {
  const partner = await findPartner(ref);
  const sets: string[] = [];
  const params: unknown[] = [partner.id];
  for (const key of PARTNER_UPDATABLE) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) {
    throw new Error('Nu ai specificat niciun câmp de actualizat.');
  }
  const { rows } = await pool.query<PartnerRow>(
    `UPDATE facturi.partners SET ${sets.join(', ')} WHERE id = $1 RETURNING ${PARTNER_COLUMNS}`,
    params
  );
  return rows[0];
}

export interface CreateInvoiceInput {
  partner: string;
  direction: InvoiceDirection;
  series: string;
  number: string;
  issue_date: string;
  due_date: string;
  vat_rate?: number;
  net_amount?: number;
  total_amount?: number;
  currency?: string;
  notes?: string;
}

export async function createInvoice(input: CreateInvoiceInput): Promise<InvoiceRow> {
  const partner = await findPartner(input.partner);
  const vatRate = input.vat_rate ?? 19;
  const amounts = computeAmounts({ netAmount: input.net_amount, totalAmount: input.total_amount, vatRate });

  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO facturi.invoices
         (partner_id, direction, series, number, issue_date, due_date, currency,
          vat_rate, net_amount, vat_amount, total_amount, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'RON'), $8, $9, $10, $11, 'issued', $12)
       RETURNING id`,
      [
        partner.id,
        input.direction,
        input.series,
        input.number,
        input.issue_date,
        input.due_date,
        input.currency ?? null,
        vatRate,
        amounts.netAmount,
        amounts.vatAmount,
        amounts.totalAmount,
        input.notes ?? null,
      ]
    );
    return findInvoice({ invoice_id: rows[0].id });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new Error(
        `Există deja o factură ${input.direction === 'issued' ? 'emisă' : 'primită'} cu seria ${input.series} și numărul ${input.number}.`
      );
    }
    if ((err as { code?: string }).code === '23514') {
      throw new Error('Datele facturii încalcă regulile: scadența nu poate fi înaintea datei de emitere, iar sumele nu pot fi negative.');
    }
    throw err;
  }
}

export interface RegisterPaymentInput {
  invoice_id?: number;
  series?: string;
  number?: string;
  direction?: InvoiceDirection;
  amount: number;
  payment_date?: string;
  method?: 'bank_transfer' | 'cash' | 'card' | 'other';
  reference?: string;
  notes?: string;
}

/**
 * Înregistrează o plată/încasare și recalculează statusul facturii,
 * totul într-o singură tranzacție (factura e blocată cu FOR UPDATE).
 */
export async function registerPayment(input: RegisterPaymentInput): Promise<{ invoice: InvoiceRow; payment_id: number }> {
  const found = await findInvoice(input);
  if (found.status === 'canceled') {
    throw new Error(`Factura ${found.series} ${found.number} este anulată — nu se pot înregistra plăți pe ea.`);
  }

  const paymentId = await withTransaction(async (client: pg.PoolClient) => {
    const { rows: locked } = await client.query<{ total_amount: number; status: InvoiceStatus; due_date: string }>(
      `SELECT total_amount::float8 AS total_amount, status, due_date::text AS due_date
       FROM facturi.invoices WHERE id = $1 FOR UPDATE`,
      [found.id]
    );
    const invoice = locked[0];

    const { rows: paidRows } = await client.query<{ paid: number }>(
      `SELECT COALESCE(SUM(amount), 0)::float8 AS paid FROM facturi.payments WHERE invoice_id = $1`,
      [found.id]
    );
    const alreadyPaid = paidRows[0].paid;
    const newTotal = round2(alreadyPaid + input.amount);
    if (newTotal > invoice.total_amount) {
      throw new Error(
        `Plata de ${input.amount.toFixed(2)} depășește restul de plată: factura are totalul ` +
          `${invoice.total_amount.toFixed(2)}, din care ${alreadyPaid.toFixed(2)} deja achitat ` +
          `(rest ${round2(invoice.total_amount - alreadyPaid).toFixed(2)}).`
      );
    }

    const { rows: inserted } = await client.query<{ id: number }>(
      `INSERT INTO facturi.payments (invoice_id, payment_date, amount, method, reference, notes)
       VALUES ($1, COALESCE($2, CURRENT_DATE), $3, COALESCE($4, 'bank_transfer'), $5, $6)
       RETURNING id`,
      [found.id, input.payment_date ?? null, input.amount, input.method ?? null, input.reference ?? null, input.notes ?? null]
    );

    const newStatus = computeInvoiceStatus({
      totalAmount: invoice.total_amount,
      paidAmount: newTotal,
      dueDate: invoice.due_date,
      currentStatus: invoice.status,
      today: todayIso(),
    });
    await client.query(`UPDATE facturi.invoices SET status = $2 WHERE id = $1`, [found.id, newStatus]);
    return inserted[0].id;
  });

  return { invoice: await findInvoice({ invoice_id: found.id }), payment_id: paymentId };
}

/** Anulează o factură; refuză dacă are plăți înregistrate. */
export async function cancelInvoice(ref: {
  invoice_id?: number;
  series?: string;
  number?: string;
  direction?: InvoiceDirection;
}): Promise<InvoiceRow> {
  const found = await findInvoice(ref);
  if (found.paid_amount > 0) {
    throw new Error(
      `Factura ${found.series} ${found.number} are plăți înregistrate (${found.paid_amount.toFixed(2)} ${found.currency}) ` +
        `și nu poate fi anulată. Stornează plățile mai întâi sau corectează manual.`
    );
  }
  if (found.status === 'canceled') {
    throw new Error(`Factura ${found.series} ${found.number} este deja anulată.`);
  }
  await pool.query(`UPDATE facturi.invoices SET status = 'canceled' WHERE id = $1`, [found.id]);
  return findInvoice({ invoice_id: found.id });
}
