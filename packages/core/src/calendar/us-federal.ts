import { addDays, isoDate, weekday, type IsoDate } from "@blackgold/shared";

/**
 * U.S. federal holidays computed by rule (5 U.S.C. 6103), with the federal observance shift: a holiday
 * falling on Saturday is observed the preceding Friday, one falling on Sunday the following Monday.
 * Used for release schedules of federal agencies (CFTC COT). The NYSE calendar is NOT a substitute: the
 * exchange is open on Columbus Day and Veterans Day, and the CFTC is closed.
 *
 * Verified against the published 2026 CFTC COT release schedule (docs/CAPABILITY_REGISTER.md CR-27).
 */
function nthWeekdayOfMonth(year: number, month: number, dow: number, n: number): IsoDate {
  const first = isoDate(`${year}-${String(month).padStart(2, "0")}-01`);
  const shift = (dow - weekday(first) + 7) % 7;
  return addDays(first, shift + (n - 1) * 7);
}

function lastWeekdayOfMonth(year: number, month: number, dow: number): IsoDate {
  const nextFirst = month === 12 ? isoDate(`${year + 1}-01-01`) : isoDate(`${year}-${String(month + 1).padStart(2, "0")}-01`);
  const last = addDays(nextFirst, -1);
  const back = (weekday(last) - dow + 7) % 7;
  return addDays(last, -back);
}

function observed(date: IsoDate): IsoDate {
  const dow = weekday(date);
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return date;
}

/** Observed federal holidays whose observance date falls in `year`, sorted. */
export function federalHolidays(year: number): IsoDate[] {
  const fixed = (y: number, mmdd: string): IsoDate => observed(isoDate(`${y}-${mmdd}`));
  const candidates: IsoDate[] = [];
  for (const y of [year - 1, year, year + 1]) {
    candidates.push(fixed(y, "01-01")); // New Year's Day
    candidates.push(nthWeekdayOfMonth(y, 1, 1, 3)); // Birthday of Martin Luther King, Jr.
    candidates.push(nthWeekdayOfMonth(y, 2, 1, 3)); // Washington's Birthday
    candidates.push(lastWeekdayOfMonth(y, 5, 1)); // Memorial Day
    if (y >= 2021) candidates.push(fixed(y, "06-19")); // Juneteenth National Independence Day (since 2021)
    candidates.push(fixed(y, "07-04")); // Independence Day
    candidates.push(nthWeekdayOfMonth(y, 9, 1, 1)); // Labor Day
    candidates.push(nthWeekdayOfMonth(y, 10, 1, 2)); // Columbus Day
    candidates.push(fixed(y, "11-11")); // Veterans Day
    candidates.push(nthWeekdayOfMonth(y, 11, 4, 4)); // Thanksgiving Day
    candidates.push(fixed(y, "12-25")); // Christmas Day
  }
  const prefix = `${year}-`;
  return [...new Set(candidates.filter((d) => d.startsWith(prefix)))].sort();
}

const cache = new Map<number, Set<string>>();

export function isFederalHoliday(date: IsoDate): boolean {
  const year = Number(date.slice(0, 4));
  let set = cache.get(year);
  if (!set) {
    set = new Set(federalHolidays(year));
    cache.set(year, set);
  }
  return set.has(date);
}

/** Monday through Friday and not a federal holiday. */
export function isFederalBusinessDay(date: IsoDate): boolean {
  const dow = weekday(date);
  return dow !== 0 && dow !== 6 && !isFederalHoliday(date);
}
