/**
 * Transformă perioadele relative din prompturi în intervale concrete de date.
 * Convenții (documentate și în descrierile tool-urilor):
 *  - last_month / last_year  = luna / anul CALENDARISTIC precedent
 *  - last_two_weeks          = ultimele 14 zile, inclusiv ziua curentă
 *  - next_month              = luna calendaristică următoare
 *  - current_month           = luna calendaristică curentă
 *  - year_to_date            = de la 1 ianuarie până azi
 */

export const RELATIVE_PERIODS = [
  'last_two_weeks',
  'last_month',
  'last_year',
  'next_month',
  'current_month',
  'year_to_date',
] as const;

export type RelativePeriod = (typeof RELATIVE_PERIODS)[number];

/** Interval închis de date calendaristice, în format YYYY-MM-DD. */
export interface DateRange {
  from: string;
  to: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Ultima zi a lunii date (month: 0-11). */
function endOfMonth(year: number, month: number): Date {
  return new Date(year, month + 1, 0);
}

export function resolvePeriod(
  input: { period?: RelativePeriod; from?: string; to?: string },
  today: Date = new Date()
): DateRange {
  const { period, from, to } = input;

  if (from || to) {
    if (!from || !to) {
      throw new Error('Intervalul explicit necesită ambele capete: "from" și "to" (format YYYY-MM-DD).');
    }
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      throw new Error(`Datele trebuie să fie în format YYYY-MM-DD (am primit from="${from}", to="${to}").`);
    }
    if (from > to) {
      throw new Error(`Interval invalid: "from" (${from}) este după "to" (${to}).`);
    }
    return { from, to };
  }

  const y = today.getFullYear();
  const m = today.getMonth();

  switch (period) {
    case 'last_two_weeks': {
      const start = new Date(y, m, today.getDate() - 13);
      return { from: iso(start), to: iso(today) };
    }
    case 'last_month':
      return { from: iso(new Date(y, m - 1, 1)), to: iso(endOfMonth(y, m - 1)) };
    case 'last_year':
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case 'next_month':
      return { from: iso(new Date(y, m + 1, 1)), to: iso(endOfMonth(y, m + 1)) };
    case 'current_month':
      return { from: iso(new Date(y, m, 1)), to: iso(endOfMonth(y, m)) };
    case 'year_to_date':
      return { from: `${y}-01-01`, to: iso(today) };
    case undefined:
      throw new Error('Specifică o perioadă: fie "period" (ex. last_month), fie intervalul explicit "from"/"to".');
  }
}

/** Data curentă în format YYYY-MM-DD (folosită la calculul restanțelor). */
export function todayIso(today: Date = new Date()): string {
  return iso(today);
}
