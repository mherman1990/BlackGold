import {
  addDays,
  compareInstants,
  dateOfInstantInZone,
  isoDate,
  weekday,
  zonedToUtc,
  type IsoDate,
  type UtcInstant,
} from "@blackgold/shared";
import { NotASessionError, type ExchangeCalendar } from "./types.ts";

/**
 * NYSE (MIC XNYS) calendar computed BY RULE for 2000-2100. Rules verified against
 * https://www.nyse.com/markets/hours-calendars (accessed 2026-09-06); the 2026/2027 schedules are test fixtures.
 *
 * Unscheduled closures (national days of mourning, disasters) cannot be derived by rule; pass them as
 * `adHocClosures`. Any date not in the supported range throws.
 */

const NY = "America/New_York";
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

export type NyseCalendarOptions = { adHocClosures?: readonly IsoDate[] };

export type HolidaySchedule = { holidays: IsoDate[]; earlyCloses: IsoDate[] };

export class NyseCalendar implements ExchangeCalendar {
  readonly exchange = "XNYS";
  readonly timeZone = NY;
  private readonly adHoc: ReadonlySet<string>;
  private readonly cache = new Map<number, { holidays: Set<string>; earlyCloses: Set<string> }>();

  constructor(options: NyseCalendarOptions = {}) {
    this.adHoc = new Set(options.adHocClosures ?? []);
  }

  isSession(date: IsoDate): boolean {
    const wd = weekday(date);
    if (wd === 0 || wd === 6) return false;
    if (this.adHoc.has(date)) return false;
    return !this.yearSchedule(yearOf(date)).holidays.has(date);
  }

  isHoliday(date: IsoDate): boolean {
    return this.yearSchedule(yearOf(date)).holidays.has(date) || this.adHoc.has(date);
  }

  isEarlyClose(date: IsoDate): boolean {
    return this.isSession(date) && this.yearSchedule(yearOf(date)).earlyCloses.has(date);
  }

  sessionOpen(date: IsoDate): UtcInstant {
    this.assertSession(date);
    return zonedToUtc(date, 9, 30, NY);
  }

  sessionClose(date: IsoDate): UtcInstant {
    this.assertSession(date);
    return this.isEarlyClose(date) ? zonedToUtc(date, 13, 0, NY) : zonedToUtc(date, 16, 0, NY);
  }

  nextSession(after: UtcInstant): IsoDate {
    let d = dateOfInstantInZone(after, NY);
    for (let i = 0; i < 30; i++) {
      if (this.isSession(d) && compareInstants(this.sessionOpen(d), after) > 0) return d;
      d = addDays(d, 1);
    }
    throw new RangeError(`No session found within 30 days after ${after}`);
  }

  previousSession(before: UtcInstant): IsoDate {
    let d = dateOfInstantInZone(before, NY);
    for (let i = 0; i < 30; i++) {
      if (this.isSession(d) && compareInstants(this.sessionClose(d), before) <= 0) return d;
      d = addDays(d, -1);
    }
    throw new RangeError(`No session found within 30 days before ${before}`);
  }

  sessionDates(from: IsoDate, to: IsoDate): IsoDate[] {
    const out: IsoDate[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (this.isSession(d)) out.push(d);
    return out;
  }

  /** Rule-derived schedule for a year (ad hoc closures excluded). Sorted ascending. */
  schedule(year: number): HolidaySchedule {
    const s = this.yearSchedule(year);
    return {
      holidays: [...s.holidays].sort().map(isoDate),
      earlyCloses: [...s.earlyCloses].sort().map(isoDate),
    };
  }

  private assertSession(date: IsoDate): void {
    if (!this.isSession(date)) throw new NotASessionError(this.exchange, date);
  }

  private yearSchedule(year: number): { holidays: Set<string>; earlyCloses: Set<string> } {
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
      throw new RangeError(`NyseCalendar supports ${MIN_YEAR}-${MAX_YEAR}; got ${year}`);
    }
    const cached = this.cache.get(year);
    if (cached) return cached;
    const holidays = new Set<string>(nyseHolidays(year));
    const earlyCloses = new Set<string>(nyseEarlyCloses(year, holidays));
    const built = { holidays, earlyCloses };
    this.cache.set(year, built);
    return built;
  }
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

function ymd(year: number, month: number, day: number): IsoDate {
  return isoDate(`${year}-${pad(month)}-${pad(day)}`);
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Nth (1-based) given weekday (0=Sun..6=Sat) of a month. */
function nthWeekdayOfMonth(year: number, month: number, wd: number, n: number): IsoDate {
  const first = ymd(year, month, 1);
  const offset = (wd - weekday(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

function lastWeekdayOfMonth(year: number, month: number, wd: number): IsoDate {
  const nextFirst = month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1);
  const last = addDays(nextFirst, -1);
  const back = (weekday(last) - wd + 7) % 7;
  return addDays(last, -back);
}

/** Saturday -> preceding Friday; Sunday -> following Monday; otherwise the date itself. */
function observed(date: IsoDate): IsoDate {
  const wd = weekday(date);
  if (wd === 6) return addDays(date, -1);
  if (wd === 0) return addDays(date, 1);
  return date;
}

/** Gregorian Easter Sunday (Anonymous/Meeus algorithm). */
export function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

/** Full-day NYSE holidays for a year. Only weekdays are returned; weekend-observed rules applied. */
export function nyseHolidays(year: number): IsoDate[] {
  const out: IsoDate[] = [];
  // New Year's Day: Sunday -> Monday Jan 2; Saturday -> NOT observed (NYSE does not close Dec 31).
  const jan1 = ymd(year, 1, 1);
  if (weekday(jan1) === 0) out.push(addDays(jan1, 1));
  else if (weekday(jan1) !== 6) out.push(jan1);
  out.push(nthWeekdayOfMonth(year, 1, 1, 3)); // Martin Luther King Jr. Day
  out.push(nthWeekdayOfMonth(year, 2, 1, 3)); // Washington's Birthday
  out.push(addDays(easterSunday(year), -2)); // Good Friday
  out.push(lastWeekdayOfMonth(year, 5, 1)); // Memorial Day
  if (year >= 2022) out.push(observed(ymd(year, 6, 19))); // Juneteenth
  out.push(observed(ymd(year, 7, 4))); // Independence Day
  out.push(nthWeekdayOfMonth(year, 9, 1, 1)); // Labor Day
  out.push(nthWeekdayOfMonth(year, 11, 4, 4)); // Thanksgiving
  out.push(observed(ymd(year, 12, 25))); // Christmas
  return out.sort();
}

/** 13:00 ET early closes: day after Thanksgiving; July 3 and December 24 when each is a weekday and not a holiday. */
export function nyseEarlyCloses(year: number, holidays: ReadonlySet<string>): IsoDate[] {
  const out: IsoDate[] = [];
  out.push(addDays(nthWeekdayOfMonth(year, 11, 4, 4), 1));
  for (const candidate of [ymd(year, 7, 3), ymd(year, 12, 24)]) {
    const wd = weekday(candidate);
    if (wd !== 0 && wd !== 6 && !holidays.has(candidate)) out.push(candidate);
  }
  return out.sort();
}
