import { isoDate, type IsoDate } from "@blackgold/shared";

/**
 * The date spellings issuer distribution files use (D-58). Each returns `undefined` for anything that is not
 * exactly its format and a real calendar date, so a parser can fail closed on it rather than guess.
 */

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

function real(yyyy: string, mm: string, dd: string): IsoDate | undefined {
  try {
    return isoDate(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`);
  } catch {
    return undefined;
  }
}

/** `MM/DD/YYYY`, as SSGA's distribution workbook writes it. */
export function usSlashDate(text: string): IsoDate | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  return m?.[1] === undefined || m[2] === undefined || m[3] === undefined ? undefined : real(m[3], m[1], m[2]);
}

/** `DD-Mon-YYYY`, as SSGA's NAV history writes it. */
export function dayMonthYearDate(text: string): IsoDate | undefined {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text.trim());
  const month = m?.[2] === undefined ? undefined : MONTHS[m[2].toLowerCase()];
  return m?.[1] === undefined || m[3] === undefined || month === undefined ? undefined : real(m[3], month, m[1]);
}

/** `Mon DD, YYYY`, as iShares' fund workbook writes it. */
export function monthDayYearDate(text: string): IsoDate | undefined {
  const m = /^([A-Za-z]{3}) (\d{1,2}), (\d{4})$/.exec(text.trim());
  const month = m?.[1] === undefined ? undefined : MONTHS[m[1].toLowerCase()];
  return m?.[2] === undefined || m[3] === undefined || month === undefined ? undefined : real(m[3], month, m[2]);
}

/** `YYYY-MM-DD`, as Vanguard's JSON writes it. */
export function plainIsoDate(text: string): IsoDate | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  return m?.[1] === undefined || m[2] === undefined || m[3] === undefined ? undefined : real(m[1], m[2], m[3]);
}
