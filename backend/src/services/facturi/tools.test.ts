import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { executeFacturiTool, facturiToolDefs, facturiToolLabel } from './tools.js';

// Sufix unic per rulare, ca testele să nu se calce cu datele demo sau între ele.
const runId = String(Date.now()).slice(-9);
const CUI = runId; // CUI valid: doar cifre
const SERIES = 'TST';
const NUMBER = `IT-${runId}`;

afterAll(async () => {
  // Curățenie: ștergem tot ce a creat testul (cascadă manuală, în ordine).
  await pool.query(
    `DELETE FROM facturi.payments WHERE invoice_id IN
       (SELECT id FROM facturi.invoices WHERE partner_id IN (SELECT id FROM facturi.partners WHERE cui = $1))`,
    [CUI]
  );
  await pool.query(`DELETE FROM facturi.invoices WHERE partner_id IN (SELECT id FROM facturi.partners WHERE cui = $1)`, [
    CUI,
  ]);
  await pool.query(`DELETE FROM facturi.partners WHERE cui = $1`, [CUI]);
  await pool.end();
});

async function run(name: string, args: unknown): Promise<Record<string, unknown>> {
  return JSON.parse(await executeFacturiTool(name, args));
}

describe('dispatcher (fără DB)', () => {
  it('expune definițiile tuturor tool-urilor', () => {
    expect(facturiToolDefs.map((t) => t.function.name)).toContain('list_invoices_to_pay');
    expect(facturiToolDefs).toHaveLength(12);
  });

  it('are etichete pentru UI', () => {
    expect(facturiToolLabel('get_balance')).toMatch(/balanța/i);
    expect(facturiToolLabel('necunoscut')).toMatch(/necunoscut/);
  });

  it('tool necunoscut → eroare structurată, nu excepție', async () => {
    const result = await run('tool_inexistent', {});
    expect(result.error).toMatch(/Tool necunoscut/);
  });

  it('argumente invalide → eroare zod descriptivă în română', async () => {
    const result = await run('register_payment', { amount: -5 });
    expect(result.error).toMatch(/Argumente invalide/);
  });

  it('add_partner fără tipul partenerului → cere informații, nu inventează', async () => {
    const result = await run('add_partner', { name: 'Firma Fantomă SRL', cui: '99999999' });
    expect(result.needs_info).toBe(true);
    expect(String(result.message)).toMatch(/client/);
  });
});

describe('flux complet pe DB (partener → factură → plăți → status)', () => {
  it('adaugă partenerul cu CUI normalizat', async () => {
    const result = await run('add_partner', { name: `Partener Test ${runId}`, cui: `RO ${CUI}`, is_client: true });
    const partner = result.partner as { cui: string; is_client: boolean };
    expect(result.error).toBeUndefined();
    expect(partner.cui).toBe(CUI);
    expect(partner.is_client).toBe(true);
  });

  it('refuză CUI duplicat', async () => {
    const result = await run('add_partner', { name: 'Alt Nume SRL', cui: CUI, is_client: true });
    expect(result.error).toMatch(/Există deja un partener/);
  });

  it('creează factura calculând TVA din bază', async () => {
    const result = await run('create_invoice', {
      partner: CUI,
      direction: 'issued',
      series: SERIES,
      number: NUMBER,
      issue_date: '2026-01-10',
      due_date: '2099-01-31',
      net_amount: 1000,
    });
    const invoice = result.invoice as { total_amount: number; status: string };
    expect(result.error).toBeUndefined();
    expect(invoice.total_amount).toBe(1190);
    expect(invoice.status).toBe('issued');
  });

  it('încasare parțială → partially_paid', async () => {
    const result = await run('register_payment', { series: SERIES, number: NUMBER, amount: 500 });
    const invoice = result.invoice as { status: string; remaining_amount: number };
    expect(result.error).toBeUndefined();
    expect(invoice.status).toBe('partially_paid');
    expect(invoice.remaining_amount).toBe(690);
  });

  it('plata care depășește restul este refuzată', async () => {
    const result = await run('register_payment', { series: SERIES, number: NUMBER, amount: 800 });
    expect(result.error).toMatch(/depășește restul de plată/);
  });

  it('încasarea restului → paid și dispare din facturile de încasat', async () => {
    const payment = await run('register_payment', { series: SERIES, number: NUMBER, amount: 690 });
    expect((payment.invoice as { status: string }).status).toBe('paid');

    const list = await run('list_invoices_to_collect', { partner: CUI });
    expect(list.count).toBe(0);
  });

  it('factura cu plăți nu poate fi anulată', async () => {
    const result = await run('cancel_invoice', { series: SERIES, number: NUMBER });
    expect(result.error).toMatch(/nu poate fi anulată/);
  });

  it('fișa partenerului reflectă soldul zero după încasarea integrală', async () => {
    const result = await run('get_partner_statement', { partner: CUI });
    expect(result.they_owe_us).toBe(0);
    expect((result.invoices as unknown[]).length).toBe(1);
  });
});
