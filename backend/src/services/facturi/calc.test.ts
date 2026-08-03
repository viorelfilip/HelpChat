import { describe, expect, it } from 'vitest';
import { computeAmounts, computeInvoiceStatus, normalizeCui, round2 } from './calc.js';

describe('normalizeCui', () => {
  it('elimină prefixul RO și spațiile', () => {
    expect(normalizeCui('RO 143 998 40')).toBe('14399840');
    expect(normalizeCui('ro14399840')).toBe('14399840');
    expect(normalizeCui('  987654 ')).toBe('987654');
  });

  it('respinge valorile care nu arată a CUI', () => {
    expect(() => normalizeCui('ABC123')).toThrow(/CUI invalid/);
    expect(() => normalizeCui('')).toThrow(/CUI invalid/);
    expect(() => normalizeCui('12345678901')).toThrow(/CUI invalid/);
  });
});

describe('computeAmounts', () => {
  it('calculează TVA și total din bază', () => {
    expect(computeAmounts({ netAmount: 1000, vatRate: 19 })).toEqual({
      netAmount: 1000,
      vatAmount: 190,
      totalAmount: 1190,
    });
  });

  it('calculează baza și TVA din total', () => {
    expect(computeAmounts({ totalAmount: 1190, vatRate: 19 })).toEqual({
      netAmount: 1000,
      vatAmount: 190,
      totalAmount: 1190,
    });
  });

  it('rotunjește bănește la 2 zecimale', () => {
    const r = computeAmounts({ netAmount: 33.33, vatRate: 19 });
    expect(r.vatAmount).toBe(6.33); // 33.33 * 0.19 = 6.3327
    expect(r.totalAmount).toBe(39.66);
  });

  it('acceptă cota 0 (scutit de TVA)', () => {
    expect(computeAmounts({ netAmount: 500, vatRate: 0 })).toEqual({
      netAmount: 500,
      vatAmount: 0,
      totalAmount: 500,
    });
  });

  it('refuză bază + total simultan sau niciuna', () => {
    expect(() => computeAmounts({ netAmount: 100, totalAmount: 119, vatRate: 19 })).toThrow(/nu ambele/);
    expect(() => computeAmounts({ vatRate: 19 })).toThrow(/Specifică/);
  });
});

describe('computeInvoiceStatus', () => {
  const base = { totalAmount: 1190, dueDate: '2026-04-01', currentStatus: 'issued' as const, today: '2026-03-15' };

  it('paid când plățile acoperă totalul', () => {
    expect(computeInvoiceStatus({ ...base, paidAmount: 1190 })).toBe('paid');
    expect(computeInvoiceStatus({ ...base, paidAmount: 1200 })).toBe('paid');
  });

  it('partially_paid când 0 < plăți < total și scadența nu a trecut', () => {
    expect(computeInvoiceStatus({ ...base, paidAmount: 500 })).toBe('partially_paid');
  });

  it('issued când nu există plăți și scadența nu a trecut', () => {
    expect(computeInvoiceStatus({ ...base, paidAmount: 0 })).toBe('issued');
  });

  it('overdue când scadența a trecut și nu e plătită integral', () => {
    expect(computeInvoiceStatus({ ...base, paidAmount: 0, dueDate: '2026-03-01' })).toBe('overdue');
    expect(computeInvoiceStatus({ ...base, paidAmount: 500, dueDate: '2026-03-01' })).toBe('overdue');
  });

  it('draft și canceled nu se recalculează', () => {
    expect(computeInvoiceStatus({ ...base, paidAmount: 1190, currentStatus: 'draft' })).toBe('draft');
    expect(computeInvoiceStatus({ ...base, paidAmount: 1190, currentStatus: 'canceled' })).toBe('canceled');
  });

  it('plata integrală are prioritate față de scadența depășită', () => {
    expect(computeInvoiceStatus({ ...base, paidAmount: 1190, dueDate: '2026-03-01' })).toBe('paid');
  });
});

describe('round2', () => {
  it('rotunjește corect valori cu erori binare', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1190.005)).toBe(1190.01);
  });
});
