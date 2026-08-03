import { describe, expect, it } from 'vitest';
import { resolvePeriod, todayIso } from './perioade.js';

// Zi fixă de referință: 15 martie 2026 (duminică).
const today = new Date(2026, 2, 15);

describe('resolvePeriod', () => {
  it('last_month = luna calendaristică precedentă', () => {
    expect(resolvePeriod({ period: 'last_month' }, today)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('last_year = anul calendaristic precedent', () => {
    expect(resolvePeriod({ period: 'last_year' }, today)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('last_two_weeks = ultimele 14 zile, inclusiv azi', () => {
    expect(resolvePeriod({ period: 'last_two_weeks' }, today)).toEqual({ from: '2026-03-02', to: '2026-03-15' });
  });

  it('next_month = luna calendaristică următoare', () => {
    expect(resolvePeriod({ period: 'next_month' }, today)).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it('current_month = luna curentă completă', () => {
    expect(resolvePeriod({ period: 'current_month' }, today)).toEqual({ from: '2026-03-01', to: '2026-03-31' });
  });

  it('year_to_date = de la 1 ianuarie până azi', () => {
    expect(resolvePeriod({ period: 'year_to_date' }, today)).toEqual({ from: '2026-01-01', to: '2026-03-15' });
  });

  it('trece corect peste granița de an (last_month în ianuarie)', () => {
    expect(resolvePeriod({ period: 'last_month' }, new Date(2026, 0, 10))).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('interval explicit from/to are prioritate', () => {
    expect(resolvePeriod({ period: 'last_month', from: '2026-01-01', to: '2026-01-15' }, today)).toEqual({
      from: '2026-01-01',
      to: '2026-01-15',
    });
  });

  it('interval explicit incomplet → eroare descriptivă', () => {
    expect(() => resolvePeriod({ from: '2026-01-01' }, today)).toThrow(/ambele capete/);
  });

  it('from după to → eroare', () => {
    expect(() => resolvePeriod({ from: '2026-02-01', to: '2026-01-01' }, today)).toThrow(/Interval invalid/);
  });

  it('fără period și fără interval → eroare', () => {
    expect(() => resolvePeriod({}, today)).toThrow(/Specifică o perioadă/);
  });
});

describe('todayIso', () => {
  it('formatează data curentă ca YYYY-MM-DD', () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
