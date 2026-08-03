/** Funcții pure de calcul financiar — testabile fără DB. */

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'overdue' | 'canceled';
export type InvoiceDirection = 'issued' | 'received';

/** Rotunjire bănească la 2 zecimale (banii se calculează în lei, nu în bani). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Normalizează un CUI românesc: elimină prefixul "RO" și spațiile.
 * Aruncă eroare descriptivă dacă rezultatul nu arată a CUI.
 */
export function normalizeCui(raw: string): string {
  const cui = raw.trim().toUpperCase().replace(/\s+/g, '').replace(/^RO/, '');
  if (!/^\d{1,10}$/.test(cui)) {
    throw new Error(`CUI invalid: "${raw}". CUI-ul trebuie să conțină doar cifre (opțional cu prefixul RO).`);
  }
  return cui;
}

export interface InvoiceAmounts {
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
}

/**
 * Calculează baza, TVA-ul și totalul unei facturi pornind fie de la bază
 * (netAmount), fie de la total (totalAmount), cu cota de TVA dată în procente.
 */
export function computeAmounts(input: { netAmount?: number; totalAmount?: number; vatRate: number }): InvoiceAmounts {
  const { netAmount, totalAmount, vatRate } = input;
  if (vatRate < 0) throw new Error(`Cota de TVA nu poate fi negativă (am primit ${vatRate}).`);

  if (netAmount !== undefined && totalAmount !== undefined) {
    throw new Error('Specifică fie baza impozabilă (net_amount), fie totalul (total_amount) — nu ambele.');
  }
  if (netAmount !== undefined) {
    if (netAmount < 0) throw new Error('Baza impozabilă nu poate fi negativă.');
    const vat = round2((netAmount * vatRate) / 100);
    return { netAmount: round2(netAmount), vatAmount: vat, totalAmount: round2(netAmount + vat) };
  }
  if (totalAmount !== undefined) {
    if (totalAmount < 0) throw new Error('Totalul facturii nu poate fi negativ.');
    const net = round2(totalAmount / (1 + vatRate / 100));
    return { netAmount: net, vatAmount: round2(totalAmount - net), totalAmount: round2(totalAmount) };
  }
  throw new Error('Specifică baza impozabilă (net_amount) sau totalul (total_amount) al facturii.');
}

/**
 * Statusul unei facturi în funcție de plăți și scadență.
 * `draft` și `canceled` sunt stări manuale — nu se recalculează.
 * `overdue` are prioritate față de `partially_paid` (scadența depășită
 * semnalează problema, iar plățile parțiale se văd în fișa facturii).
 */
export function computeInvoiceStatus(input: {
  totalAmount: number;
  paidAmount: number;
  dueDate: string; // YYYY-MM-DD
  currentStatus: InvoiceStatus;
  today: string; // YYYY-MM-DD
}): InvoiceStatus {
  const { totalAmount, paidAmount, dueDate, currentStatus, today } = input;
  if (currentStatus === 'draft' || currentStatus === 'canceled') return currentStatus;
  if (round2(paidAmount) >= round2(totalAmount) && totalAmount > 0) return 'paid';
  if (dueDate < today) return 'overdue';
  return paidAmount > 0 ? 'partially_paid' : 'issued';
}

/** Formatare bănească pentru rezumatele textuale ale tool-urilor. */
export function fmtMoney(amount: number, currency = 'RON'): string {
  return `${amount.toFixed(2)} ${currency}`;
}
