import readXlsxFile from "read-excel-file/node";
import { Dec, isoDate, type IsoDate } from "@blackgold/shared";
import type { SourceCashDividend, SourceSplit } from "../corporate-actions-reconcile.ts";
import { decimalString, SchemaDriftError } from "./common.ts";
import { dayMonthYearDate, usSlashDate } from "./issuer-dates.ts";

/**
 * State Street (SSGA) SPDR distribution and split records, as D-57 reconciliation input (D-58).
 *
 * Two public workbooks, both from `www.ssga.com`, both decoded here from bytes - fetching is a separate layer:
 *
 *  - **The all-funds distribution workbook** (`spdr-etf-historical-distributions.xlsx`): one row per fund and
 *    ex-date, with the dividend and the short- and long-term capital gains in separate columns. A record's amount
 *    is their sum, because the total-return series needs everything that went ex that day. Rows whose total is
 *    zero (BIL paid nothing for long stretches of zero rates) are not distributions and are counted, not emitted.
 *    The workbook lists no splits.
 *  - **Each fund's NAV history** (`navhist-us-en-<etf>.xlsx`): daily NAV and shares outstanding, unadjusted. A
 *    split shows as NAV dropping by the ratio while shares outstanding rise by it. A record is emitted only when
 *    both one-day ratios sit near the SAME standard ratio (NAV within 15%, which leaves room for the market's move
 *    that day; shares within 5%, which leaves room for that day's creations and redemptions). Any other one-day NAV
 *    move beyond 20% is reported as a jump and never becomes a record: a ratio guessed from an unexplained move
 *    would be a fabricated number, and the reconciler's exact-match rule on split ratios is what makes this safe -
 *    a wrong ratio cannot agree with the vendor's.
 *
 * Both are untrusted external data and fail closed on any surprise in the funds asked for: a missing header, an
 * unreadable date or amount, a negative amount, or a fund listed twice on one ex-date all raise
 * `SchemaDriftError`. The one tolerated defect is a pay date before its ex-date: it is dropped and reported (see
 * `payDateDropped`), since the pay date is never read for returns. Rows for other funds are not read at all, so a quirk in one of the
 * workbook's 180 other funds cannot block these.
 */
export const SSGA_DISTRIBUTIONS_SOURCE = "issuer:ssga-distributions";
export const SSGA_NAV_HISTORY_SOURCE = "issuer:ssga-nav-history";
export const SSGA_DISTRIBUTIONS_PARSER_VERSION = "1.0.0";

const DIST_ID = "issuer.ssga.distributions";
const NAV_ID = "issuer.ssga.nav-history";

function cellText(cell: unknown): string {
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number" || typeof cell === "bigint") return String(cell);
  return "";
}

/** A date cell: a Date the reader decoded, or text in the workbook's own spelling. */
function cellDate(cell: unknown, fromText: (s: string) => IsoDate | undefined): IsoDate | undefined {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? undefined : isoDate(cell.toISOString().slice(0, 10));
  return fromText(cellText(cell));
}

/** A non-negative decimal from a cell; blank reads as zero. */
function amountCell(cell: unknown, what: string): Dec {
  const text = typeof cell === "number" ? decimalString(cell) : cellText(cell);
  if (text === "") return new Dec(0);
  let d: Dec;
  try {
    d = new Dec(decimalString(text));
  } catch {
    throw new SchemaDriftError(DIST_ID, `${what} is not a decimal: "${text}"`);
  }
  if (d.isNegative()) throw new SchemaDriftError(DIST_ID, `${what} is negative: ${d.toFixed()}`);
  return d;
}

async function firstSheet(bytes: Uint8Array, sourceId: string): Promise<readonly (readonly unknown[])[]> {
  let sheets: Awaited<ReturnType<typeof readXlsxFile>>;
  try {
    sheets = await readXlsxFile(Buffer.from(bytes));
  } catch (err) {
    throw new SchemaDriftError(sourceId, `not a readable .xlsx workbook (${err instanceof Error ? err.message : "parse error"})`);
  }
  const rows = sheets[0]?.data;
  if (rows === undefined || rows.length === 0) throw new SchemaDriftError(sourceId, "workbook has no sheet or no rows");
  return rows;
}

function findColumns<K extends string>(rows: readonly (readonly unknown[])[], want: Record<K, string>, sourceId: string): { index: number; col: Record<K, number> } {
  for (let i = 0; i < rows.length; i++) {
    const labels = (rows[i] ?? []).map((c) => cellText(c).toUpperCase());
    const col = {} as Record<K, number>;
    let all = true;
    for (const [k, label] of Object.entries(want) as [K, string][]) {
      const at = labels.indexOf(label.toUpperCase());
      if (at < 0) {
        all = false;
        break;
      }
      col[k] = at;
    }
    if (all) return { index: i, col };
  }
  throw new SchemaDriftError(sourceId, `no header row naming ${Object.values(want).join(", ")}`);
}

export type SsgaDistributions = {
  records: SourceCashDividend[];
  /** Rows in scope whose dividend and capital gains are all zero: no distribution, so no record. */
  zeroRows: { entityId: string; exDate: IsoDate }[];
  /**
   * Rows whose payable date precedes their ex-date, which cannot be true. The record keeps its ex-date and amount -
   * the only fields the total-return series reads, and the ones the reconciler cross-checks - and drops the pay
   * date, so the file falls back to the ex-date as it does for the vendor. SSGA's BIL row for 2008-03-03 carries
   * the February row's record and pay dates.
   */
  payDateDropped: { entityId: string; exDate: IsoDate; payDate: IsoDate }[];
};

/**
 * Decode the all-funds distribution workbook into one cash record per fund and ex-date, for `entities` only.
 * `locator` names the stored artifact; each record's locator appends the fund and ex-date.
 */
export async function parseSsgaDistributions(bytes: Uint8Array, opts: { entities: readonly string[]; locator: string }): Promise<SsgaDistributions> {
  const rows = await firstSheet(bytes, DIST_ID);
  const { index, col } = findColumns(
    rows,
    { ticker: "TICKER", ex: "EX-DATE", pay: "PAYABLE DATE", dividend: "DIVIDEND ($)", st: "SHORT TERM CAPITAL GAIN ($)", lt: "LONG TERM CAPITAL GAIN ($)" },
    DIST_ID,
  );
  const wanted = new Set(opts.entities.map((e) => e.trim().toUpperCase()));
  const records: SourceCashDividend[] = [];
  const zeroRows: SsgaDistributions["zeroRows"] = [];
  const payDateDropped: SsgaDistributions["payDateDropped"] = [];
  const seen = new Set<string>();
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const entityId = cellText(row[col.ticker]).toUpperCase();
    if (!wanted.has(entityId)) continue;
    const exText = cellText(row[col.ex]);
    const exDate = cellDate(row[col.ex], usSlashDate);
    if (exDate === undefined) throw new SchemaDriftError(DIST_ID, `${entityId} row ${i + 1} has an unreadable ex-date "${exText}"`);
    const where = `${entityId} ${exDate}`;
    if (seen.has(where)) throw new SchemaDriftError(DIST_ID, `${where} is listed twice; refusing to guess whether to sum or pick`);
    seen.add(where);
    const amount = amountCell(row[col.dividend], `${where} dividend`).plus(amountCell(row[col.st], `${where} short-term gain`)).plus(amountCell(row[col.lt], `${where} long-term gain`));
    if (amount.isZero()) {
      zeroRows.push({ entityId, exDate });
      continue;
    }
    const payText = cellText(row[col.pay]);
    let payDate = payText === "" && !(row[col.pay] instanceof Date) ? undefined : cellDate(row[col.pay], usSlashDate);
    if (payText !== "" && payDate === undefined) throw new SchemaDriftError(DIST_ID, `${where} has an unreadable payable date "${payText}"`);
    if (payDate !== undefined && payDate < exDate) {
      payDateDropped.push({ entityId, exDate, payDate });
      payDate = undefined;
    }
    records.push({ source: SSGA_DISTRIBUTIONS_SOURCE, kind: "CASH_DIVIDEND", entityId, exDate, amount, payDate, locator: `${opts.locator}#${entityId}/${exDate}` });
  }
  return { records, zeroRows, payDateDropped };
}

/**
 * A one-day NAV move beyond 20% that is not a recognisable split. Reported; never a record. `sharesRatio` is null
 * where either day's share count is unpublished.
 */
export type NavJump = { previousDate: IsoDate; date: IsoDate; navRatio: string; sharesRatio: string | null };

export type SsgaNavSplits = {
  records: SourceSplit[];
  jumps: NavJump[];
  firstDate: IsoDate;
  lastDate: IsoDate;
  /** The first date with a published share count. Before it no split can be confirmed, only reported as a jump. */
  sharesFirstDate: IsoDate | undefined;
};

/** New shares per old share that a split can have; each is an exact decimal, so it can match a vendor exactly. */
const STANDARD_RATIOS = ["10", "5", "4", "3", "2", "1.5", "0.5", "0.25", "0.2", "0.1"].map((r) => new Dec(r));
const JUMP_UP = new Dec("1.25");
const JUMP_DOWN = new Dec("0.8");
const NAV_BAND = new Dec("0.15");
const SHARES_BAND = new Dec("0.05");
const near = (x: Dec, r: Dec, band: Dec): boolean => x.div(r).minus(1).abs().lte(band);

/**
 * Read splits out of one fund's NAV history. The file must name the fund (`Ticker Symbol:`) and it must be `etf`.
 */
export async function ssgaNavSplits(bytes: Uint8Array, opts: { etf: string; locator: string }): Promise<SsgaNavSplits> {
  const etf = opts.etf.trim().toUpperCase();
  const rows = await firstSheet(bytes, NAV_ID);
  const { index, col } = findColumns(rows, { date: "DATE", nav: "NAV", shares: "SHARES OUTSTANDING" }, NAV_ID);
  const named = rows.slice(0, index).find((r) => cellText(r[0]).toLowerCase().startsWith("ticker"));
  const fund = named === undefined ? "" : cellText(named[1]).toUpperCase();
  if (fund !== etf) throw new SchemaDriftError(NAV_ID, fund === "" ? `the file does not name its fund; expected ${etf}` : `the file is for ${fund}, not ${etf}`);

  // SSGA writes "-" for a share count it did not publish (XLK's history has none before 2006-05-31).
  const points = new Map<IsoDate, { nav: Dec; shares: Dec | undefined }>();
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const date = cellDate(row[col.date], dayMonthYearDate);
    if (date === undefined) {
      // A blank row or the disclaimer under the table. Anything in the NAV column means the table itself changed.
      if (cellText(row[col.nav]) !== "") throw new SchemaDriftError(NAV_ID, `${etf} row ${i + 1} has a NAV but no readable date`);
      continue;
    }
    let nav: Dec;
    let shares: Dec | undefined;
    try {
      nav = new Dec(decimalString(row[col.nav] as string | number));
      shares = cellText(row[col.shares]) === "-" ? undefined : new Dec(decimalString(row[col.shares] as string | number));
    } catch {
      throw new SchemaDriftError(NAV_ID, `${etf} ${date} has an unreadable NAV or share count`);
    }
    if (!nav.isPositive() || shares?.isPositive() === false) throw new SchemaDriftError(NAV_ID, `${etf} ${date} has a non-positive NAV or share count`);
    if (points.has(date)) throw new SchemaDriftError(NAV_ID, `${etf} ${date} is listed twice`);
    points.set(date, { nav, shares });
  }
  const dates = [...points.keys()].sort();
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  if (firstDate === undefined || lastDate === undefined) throw new SchemaDriftError(NAV_ID, `${etf} has no NAV rows`);

  const records: SourceSplit[] = [];
  const jumps: NavJump[] = [];
  for (let i = 1; i < dates.length; i++) {
    const previousDate = dates[i - 1];
    const date = dates[i];
    const prev = previousDate === undefined ? undefined : points.get(previousDate);
    const cur = date === undefined ? undefined : points.get(date);
    if (previousDate === undefined || date === undefined || prev === undefined || cur === undefined) continue;
    // A 2-for-1 split halves NAV and doubles shares: both ratios read 2.
    const navRatio = prev.nav.div(cur.nav);
    if (navRatio.lt(JUMP_UP) && navRatio.gt(JUMP_DOWN)) continue;
    const sharesRatio = prev.shares === undefined || cur.shares === undefined ? undefined : cur.shares.div(prev.shares);
    const matches = sharesRatio === undefined ? [] : STANDARD_RATIOS.filter((r) => near(navRatio, r, NAV_BAND) && near(sharesRatio, r, SHARES_BAND));
    const ratio = matches.length === 1 ? matches[0] : undefined;
    if (ratio === undefined) {
      jumps.push({ previousDate, date, navRatio: navRatio.toDecimalPlaces(6).toFixed(), sharesRatio: sharesRatio?.toDecimalPlaces(6).toFixed() ?? null });
      continue;
    }
    records.push({ source: SSGA_NAV_HISTORY_SOURCE, kind: "SPLIT", entityId: etf, exDate: date, ratio, locator: `${opts.locator}#${etf}/${date}` });
  }
  const sharesFirstDate = dates.find((d) => points.get(d)?.shares !== undefined);
  return { records, jumps, firstDate, lastDate, sharesFirstDate };
}
