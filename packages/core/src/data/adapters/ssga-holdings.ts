import readXlsxFile from "read-excel-file/node";
import { Dec, isoDate, type IsoDate } from "@blackgold/shared";
import { decimalString, SchemaDriftError } from "./common.ts";

/**
 * Decoder for State Street (SSGA) SPDR ETF daily holdings files (D-53 slice 3a-2, look-through data source).
 *
 * SSGA publishes each SPDR sector fund's full holdings only as an `.xlsx` workbook
 * (`holdings-daily-us-en-<etf>.xlsx`), so the look-through engine's holdings input has to be decoded from Excel.
 * This module does exactly that and nothing more: bytes -> a structured, validated holdings snapshot. It forms
 * no network request (the fetch adapter that calls it is a separate layer) and reaches no broker or model.
 *
 * The holdings file is UNTRUSTED external data (CLAUDE.md: every feed is untrusted). Two consequences shape
 * this decoder:
 *
 *  - **A maintained, read-only reader.** Excel is decoded with `read-excel-file` (a small, ESM-native,
 *    zero-CVE reader) rather than SheetJS's npm `xlsx`, whose published build carries unfixed
 *    prototype-pollution/ReDoS advisories - not something to point at attacker-influenceable bytes.
 *  - **Fail closed on any surprise.** Every shape the file is not - unreadable workbook, no recognizable header,
 *    a fund ticker that does not match the ETF requested, no as-of date, no constituents, a constituent whose
 *    weight is blank or unreadable, or a total that does not sit near 100% of NAV - raises
 *    {@link SchemaDriftError}, and nothing is emitted. A dropped or misread constituent must never silently
 *    become a wrong (and possibly fail-open) look-through base; the whole file is rejected instead.
 *
 * The layout it targets is SSGA's: a few preamble rows (fund name, ticker, an as-of date), then a header row
 * naming at least Name / Ticker / Weight, then one row per constituent. Columns are located by header name, not
 * by fixed position, so a column reorder does not break it; the exact live layout is still worth confirming
 * against a real file on first run (like every adapter's first CR verification).
 */

export const SSGA_HOLDINGS_DECODER_VERSION = "ssga-holdings-1.0.0";

/** The point-in-time source-id prefix for SSGA holdings; the per-ETF id appends the ticker. */
export const SSGA_HOLDINGS_SOURCE_PREFIX = "etf_holdings.ssga";

/** The PIT source id for one ETF's SSGA holdings, e.g. `etf_holdings.ssga.XLI`. */
export function ssgaHoldingsSourceId(etf: string): string {
  return `${SSGA_HOLDINGS_SOURCE_PREFIX}.${etf.trim().toUpperCase()}`;
}

/** The daily-holdings download URL for one SPDR ETF on `www.ssga.com`. */
export function ssgaHoldingsUrl(etf: string): string {
  return `https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${etf.trim().toLowerCase()}.xlsx`;
}

/** One decoded constituent line: the issuer ticker, its name, and its weight as a fraction of ETF NAV (a string). */
export type SsgaHoldingLine = { symbol: string; name: string; weight: string };

/** A decoded SSGA holdings snapshot. `asOf` is the file's holdings-as-of date; weights are fractions of NAV. */
export type SsgaHoldings = { etf: string; asOf: IsoDate; lines: SsgaHoldingLine[] };

/** A constituent ticker: an uppercase symbol, optionally with dots or dashes (BRK.B, ...). Excludes cash/dash lines. */
const TICKER_RE = /^[A-Z][A-Z.-]{0,9}$/;

const HUNDRED = new Dec(100);

// The acceptable band for a decoded file's total weight (constituents + cash), in percent of NAV. SPDR sector
// funds are essentially fully invested, so the total sits just under 100%; anything materially below means rows
// were dropped or mis-scaled. Narrow by design (a compliance-completeness guard, not a research parameter).
const MIN_TOTAL_PCT = new Dec(98);
const MAX_TOTAL_PCT = new Dec(101);

/** Trimmed text of a cell; a Date is rendered ISO so it never matches a header or ticker by accident. */
function cellText(cell: unknown): string {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? "" : cell.toISOString();
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number" || typeof cell === "boolean" || typeof cell === "bigint") return String(cell);
  return ""; // null, undefined, or an unexpected object cell: not text
}

/** Parse a preamble cell as a calendar date: a Date instance, an ISO `YYYY-MM-DD`, or SSGA's `MM/DD/YYYY`. */
function cellDate(cell: unknown): IsoDate | undefined {
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? undefined : isoDate(cell.toISOString().slice(0, 10));
  }
  const s = cellText(cell);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return validIso(s.slice(0, 4), s.slice(5, 7), s.slice(8, 10));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const [, mm, dd, yyyy] = us;
    if (mm !== undefined && dd !== undefined && yyyy !== undefined) return validIso(yyyy, mm, dd);
  }
  return undefined;
}

/** Build an IsoDate only when the numeric parts are a real month/day; otherwise undefined (never throw). */
function validIso(yyyy: string, mm: string, dd: string): IsoDate | undefined {
  const m = Number(mm);
  const d = Number(dd);
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return isoDate(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`);
}

type HeaderMatch = { index: number; name: number; ticker: number; weight: number };

/** The first row that names at least Name, Ticker, and Weight columns (case-insensitive), with their indices. */
function findHeader(rows: readonly (readonly unknown[])[]): HeaderMatch | undefined {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    const labels = row.map((c) => cellText(c).toLowerCase());
    const name = labels.indexOf("name");
    const ticker = labels.indexOf("ticker");
    const weight = labels.indexOf("weight");
    if (name >= 0 && ticker >= 0 && weight >= 0) return { index: i, name, ticker, weight };
  }
  return undefined;
}

/**
 * Decode an SSGA SPDR holdings `.xlsx` into a validated {@link SsgaHoldings}. Throws {@link SchemaDriftError}
 * (and emits nothing) on any deviation from the expected shape, so a misread file fails closed. Weights are
 * converted from SSGA's percent-of-NAV column to fractions of NAV.
 */
export async function decodeSsgaHoldings(bytes: Uint8Array, opts: { etf: string }): Promise<SsgaHoldings> {
  const sourceId = ssgaHoldingsSourceId(opts.etf);
  const wantEtf = opts.etf.trim().toUpperCase();

  let sheets: Awaited<ReturnType<typeof readXlsxFile>>;
  try {
    sheets = await readXlsxFile(Buffer.from(bytes));
  } catch (err) {
    throw new SchemaDriftError(sourceId, `not a readable .xlsx workbook (${err instanceof Error ? err.message : "parse error"})`);
  }
  const rows = sheets[0]?.data;
  if (rows === undefined || rows.length === 0) throw new SchemaDriftError(sourceId, "workbook has no sheet or no rows");

  const header = findHeader(rows);
  if (header === undefined) throw new SchemaDriftError(sourceId, "no holdings header row (expected Name, Ticker, and Weight columns)");

  const preamble = rows.slice(0, header.index);

  // If the preamble names the fund's own ticker, it must be the ETF we asked for. Guards a mis-fetched file
  // (wrong URL, a stale cache) from being stored under the wrong entity.
  for (const row of preamble) {
    if (cellText(row[0]).toLowerCase().startsWith("ticker")) {
      const fund = cellText(row[1]).toUpperCase();
      if (fund !== "" && fund !== wantEtf) throw new SchemaDriftError(sourceId, `file is for ${fund}, not ${wantEtf}`);
    }
  }

  // The holdings as-of date: the first parseable date anywhere in the preamble. Without it there is no effective
  // date to stamp, so fail closed rather than guess.
  let asOf: IsoDate | undefined;
  for (const row of preamble) {
    for (const cell of row) {
      const d = cellDate(cell);
      if (d !== undefined) {
        asOf = d;
        break;
      }
    }
    if (asOf !== undefined) break;
  }
  if (asOf === undefined) throw new SchemaDriftError(sourceId, "no holdings as-of date found in the preamble");

  const lines: SsgaHoldingLine[] = [];
  // The completeness total sums EVERY row's numeric weight — constituents AND any cash/other line — so a
  // fully-invested SPDR fund totals ~100%. Reconciling cash into the total (rather than dropping it) is what
  // lets a narrow band catch a partial or mis-scaled file even though cash never enters `lines`.
  let totalPct = new Dec(0);
  for (let i = header.index + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    const symbol = cellText(row[header.ticker]).toUpperCase();
    const rawWeight = row[header.weight];
    const weightText = typeof rawWeight === "number" ? String(rawWeight) : cellText(rawWeight);

    if (!TICKER_RE.test(symbol)) {
      // A cash, "-", disclaimer, or footer row is no restricted issuer, so it is not a constituent line. Its
      // weight, when numeric, still reconciles into the completeness total (the fund's cash allocation); a
      // non-numeric one (a disclaimer cell) is ignored.
      if (weightText !== "") {
        try {
          const p = new Dec(decimalString(weightText));
          if (!p.isNegative()) totalPct = totalPct.plus(p);
        } catch {
          /* a non-numeric weight on a non-constituent row is a disclaimer/footer cell; ignore it */
        }
      }
      continue;
    }

    // A real constituent (valid ticker) MUST carry a readable, non-negative weight. A blank or unparseable
    // weight is never a row to silently drop — the dropped issuer could be restricted, which would let the ETF
    // fail-open through compliance — so fail closed on the whole file instead.
    if (weightText === "") throw new SchemaDriftError(sourceId, `constituent ${symbol} has no weight`);
    let percent: Dec;
    try {
      percent = new Dec(decimalString(weightText));
    } catch {
      throw new SchemaDriftError(sourceId, `constituent ${symbol} has an unreadable weight "${weightText}"`);
    }
    if (percent.isNegative()) throw new SchemaDriftError(sourceId, `${symbol} has a negative weight`);
    totalPct = totalPct.plus(percent);
    lines.push({ symbol, name: cellText(row[header.name]), weight: percent.div(HUNDRED).toFixed() });
  }

  if (lines.length === 0) throw new SchemaDriftError(sourceId, "no constituent rows parsed");
  // A fully-invested SPDR sector fund's holdings total ~100% of NAV; a shortfall beyond a small cash allowance
  // means constituents were dropped or the weights are mis-scaled, so fail closed rather than emit a partial
  // (undercounting) look-through base. The band is deliberately narrow around 100%.
  if (totalPct.lt(MIN_TOTAL_PCT) || totalPct.gt(MAX_TOTAL_PCT)) {
    throw new SchemaDriftError(sourceId, `holdings weights sum to ${totalPct.toFixed(2)}%, outside the expected ${MIN_TOTAL_PCT.toFixed()}-${MAX_TOTAL_PCT.toFixed()}% of NAV`);
  }

  return { etf: wantEtf, asOf, lines };
}
