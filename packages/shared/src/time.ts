/** UTC instants are ISO-8601 strings ending in Z. America/Chicago appears only at the product boundary. */
export type UtcInstant = string & { readonly __brand: "UtcInstant" };
/** Calendar date, YYYY-MM-DD, interpreted in the exchange's local calendar. */
export type IsoDate = string & { readonly __brand: "IsoDate" };

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function utc(value: string | Date | number): UtcInstant {
  if (value instanceof Date || typeof value === "number") {
    const d = typeof value === "number" ? new Date(value) : value;
    if (Number.isNaN(d.getTime())) throw new TypeError("Invalid date");
    return d.toISOString() as UtcInstant;
  }
  if (!INSTANT_RE.test(value)) throw new TypeError(`Not a UTC instant: ${value}`);
  return new Date(value).toISOString() as UtcInstant;
}

export function nowUtc(clock: () => number = Date.now): UtcInstant {
  return utc(clock());
}

export function isoDate(value: string): IsoDate {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new TypeError(`Not an ISO date: ${value}`);
  }
  return value as IsoDate;
}

export function epochMs(instant: UtcInstant): number {
  return Date.parse(instant);
}

export function compareInstants(a: UtcInstant, b: UtcInstant): number {
  return epochMs(a) - epochMs(b);
}

export function addMs(instant: UtcInstant, ms: number): UtcInstant {
  return utc(epochMs(instant) + ms);
}

/** Add whole days to a calendar date. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d.toISOString().slice(0, 10));
}

/** 0 = Sunday ... 6 = Saturday, for a calendar date. */
export function weekday(date: IsoDate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Parse an ISO-8601 duration limited to the forms we use: P#D, PT#H, PT#M, PT#S, and combinations. */
export function durationMs(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m || iso === "P" || iso === "PT") throw new TypeError(`Unsupported duration: ${iso}`);
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60_000 + Number(s) * 1000;
}

/** Display-only conversion. Never use the result in a decision. */
export function toChicagoDisplay(instant: UtcInstant): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date(instant));
}

/** Convert a wall-clock time in a named zone to a UTC instant. Used by the exchange calendar for ET sessions. */
export function zonedToUtc(date: IsoDate, hh: number, mm: number, timeZone: string): UtcInstant {
  const naive = Date.parse(`${date}T${pad(hh)}:${pad(mm)}:00Z`);
  let guess = naive;
  // Two passes: the offset at the naive guess is correct except near a DST edge; the second pass fixes that.
  for (let i = 0; i < 2; i++) {
    const offsetMin = zoneOffsetMinutes(new Date(guess), timeZone);
    guess = naive - offsetMin * 60_000;
  }
  return utc(guess);
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Offset of `timeZone` from UTC in minutes at `at` (positive east of UTC). */
export function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

export function dateOfInstantInZone(instant: UtcInstant, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return isoDate(`${get("year")}-${get("month")}-${get("day")}`);
}
