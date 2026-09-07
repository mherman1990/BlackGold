import { addDays, addMs, compareInstants, dateOfInstantInZone, epochMs, isoDate, utc, weekday, zonedToUtc, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";

/**
 * Source-specific release-lag rules (docs/DATA_PROVENANCE_SPEC.md section 3). Pure functions shared by the
 * adapters and the temporal fixture suite, so the rule under test is the rule in production.
 */
const NY = "America/New_York";

export type LagResult = { availableAt: UtcInstant; flags: string[] };

/**
 * EDGAR: filings accepted after 17:30 ET are disseminated the next business day at 06:00 ET.
 * Filings accepted on a non-business day are also disseminated the next business day at 06:00 ET.
 */
export function secDissemination(acceptanceAt: UtcInstant, calendar: ExchangeCalendar): LagResult {
  const date = dateOfInstantInZone(acceptanceAt, NY);
  const cutoff = zonedToUtc(date, 17, 30, NY);
  const isBusinessDay = calendar.isSession(date);
  if (isBusinessDay && compareInstants(acceptanceAt, cutoff) <= 0) return { availableAt: acceptanceAt, flags: [] };
  let next = addDays(date, 1);
  while (!calendar.isSession(next)) next = addDays(next, 1);
  return { availableAt: zonedToUtc(next, 6, 0, NY), flags: ["AFTER_HOURS_ACCEPTANCE"] };
}

/** Form 4 deadline: end of the second business day after the transaction date (17:30 ET filing cutoff). */
export function form4Deadline(transactionDate: IsoDate, calendar: ExchangeCalendar): UtcInstant {
  let d = transactionDate;
  let count = 0;
  while (count < 2) {
    d = addDays(d, 1);
    if (calendar.isSession(d)) count++;
  }
  return zonedToUtc(d, 17, 30, NY);
}

export function form4Flags(transactionDate: IsoDate, acceptanceAt: UtcInstant, calendar: ExchangeCalendar): LagResult {
  const dissemination = secDissemination(acceptanceAt, calendar);
  const flags = [...dissemination.flags];
  if (compareInstants(acceptanceAt, form4Deadline(transactionDate, calendar)) > 0) flags.push("LATE_FILING");
  return { availableAt: dissemination.availableAt, flags };
}

/**
 * CFTC COT: positions as of Tuesday, released Friday 15:30 ET. When Friday is a holiday the release moves to
 * the next business day at 15:30 ET. `calendar` supplies the holiday schedule (NYSE holidays approximate the
 * federal schedule; CFTC-specific deviations are recorded as observations with RELEASE_DELAYED).
 */
export function cotReleaseInstant(positionDate: IsoDate, calendar: ExchangeCalendar): LagResult {
  if (weekday(positionDate) !== 2) throw new RangeError(`COT position date must be a Tuesday, got ${positionDate}`);
  let friday = addDays(positionDate, 3);
  const flags: string[] = [];
  while (!calendar.isSession(friday)) {
    friday = addDays(friday, 1);
    if (!flags.includes("RELEASE_DELAYED")) flags.push("RELEASE_DELAYED");
  }
  return { availableAt: zonedToUtc(friday, 15, 30, NY), flags };
}

/** FRED/ALFRED: a vintage dated D is assumed released at 08:30 ET on D unless a release calendar says otherwise. */
export function fredReleaseEstimate(vintageDate: IsoDate): LagResult {
  return { availableAt: zonedToUtc(vintageDate, 8, 30, NY), flags: ["AVAILABLE_AT_ESTIMATED"] };
}

/** Form 13F: due 45 calendar days after quarter end; availability is the EDGAR dissemination instant. */
export function thirteenFDeadline(quarterEnd: IsoDate): UtcInstant {
  return zonedToUtc(addDays(quarterEnd, 45), 17, 30, NY);
}

/** Daily bar: observedAt is the session close (early closes honoured); availableAt is close + 60 min, estimated. */
export function dailyBarTimes(sessionDate: IsoDate, calendar: ExchangeCalendar): { observedAt: UtcInstant; availableAt: UtcInstant; flags: string[] } {
  const close = calendar.sessionClose(sessionDate);
  return { observedAt: close, availableAt: addMs(close, 60 * 60_000), flags: ["AVAILABLE_AT_ESTIMATED"] };
}

/** Treasury daily par yields: published after the 15:30 ET close; estimated 16:00 ET. */
export function treasuryPublicationEstimate(date: IsoDate): LagResult {
  return { availableAt: zonedToUtc(date, 16, 0, NY), flags: ["AVAILABLE_AT_ESTIMATED"] };
}

/** Quarter end containing or preceding a date. */
export function quarterEndOf(date: IsoDate): IsoDate {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const q = Math.ceil(m / 3);
  const lastMonth = q * 3;
  const last = new Date(Date.UTC(y, lastMonth, 0)).getUTCDate();
  return isoDate(`${y}-${String(lastMonth).padStart(2, "0")}-${String(last).padStart(2, "0")}`);
}

/** Convert an EDGAR acceptanceDateTime such as "2026-03-11T18:10:07.000Z" or "20260311181007" (ET) to UTC. */
export function parseEdgarAcceptance(value: string): UtcInstant {
  if (/^\d{14}$/.test(value)) {
    const date = isoDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
    const hh = Number(value.slice(8, 10));
    const mm = Number(value.slice(10, 12));
    const ss = Number(value.slice(12, 14));
    return utc(epochMs(zonedToUtc(date, hh, mm, NY)) + ss * 1000);
  }
  // EDGAR's submissions JSON encodes acceptance in Eastern wall-clock with a misleading "Z"; treat the
  // clock components as Eastern time.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!m) throw new TypeError(`Unrecognized EDGAR acceptance timestamp: ${value}`);
  const [, y, mo, d, hh, mm, ss] = m;
  const date = isoDate(`${y ?? ""}-${mo ?? ""}-${d ?? ""}`);
  return utc(epochMs(zonedToUtc(date, Number(hh), Number(mm), NY)) + Number(ss) * 1000);
}
