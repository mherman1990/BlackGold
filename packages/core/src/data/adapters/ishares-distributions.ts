import { Dec, type IsoDate } from "@blackgold/shared";
import type { SourceCashDividend } from "../corporate-actions-reconcile.ts";
import { decimalString, SchemaDriftError } from "./common.ts";
import { monthDayYearDate } from "./issuer-dates.ts";

/**
 * iShares ETF distribution records from a file the OWNER downloaded (D-58). Never fetched by code: BlackRock's
 * terms bar robots and automated copying. The file is the fund workbook the product page offers ("Detailed
 * Holdings and Analytics", e.g. `iShares-Russell-2000-ETF_fund.xls`), saved from a browser.
 *
 * Despite the extension it is SpreadsheetML - XML - and not well-formed XML: BlackRock leaves ampersands
 * unescaped, so a strict XML parser rejects it. This reads only the `Distributions` worksheet, row by row, with
 * patterns that cannot backtrack. Its `Total Distribution` column is the amount: income, capital gains and return
 * of capital all went ex that day, and the total-return series needs all of it.
 *
 * The workbook names its fund by full name, not ticker, so the caller passes the expected name and a file for any
 * other fund is refused.
 */
export const ISHARES_DISTRIBUTIONS_SOURCE = "issuer:ishares-distributions";
export const ISHARES_DISTRIBUTIONS_PARSER_VERSION = "1.0.0";

const ID = "issuer.ishares.distributions";

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * The `<ss:Data>` texts of each `<ss:Row>` in `xml`, in order. A cell this cannot read as plain text (nested
 * markup, or an `ss:Index` that skips columns) would shift every later column onto the wrong header, so any such
 * cell refuses the file instead.
 */
function rowsOf(xml: string): string[][] {
  if (/\bss:Index=/.test(xml)) throw new SchemaDriftError(ID, "the Distributions worksheet skips columns (ss:Index)");
  const rows: string[][] = [];
  for (const [n, row] of [...xml.matchAll(/<ss:Row\b[^>]*>([\s\S]*?)<\/ss:Row>/g)].entries()) {
    const body = row[1] ?? "";
    const cells = [...body.matchAll(/<ss:Data\b[^>]*>([^<]*)<\/ss:Data>/g)].map((c) => unescapeXml(c[1] ?? "").trim());
    const declared = [...body.matchAll(/<ss:Cell\b/g)].length;
    if (cells.length !== declared) throw new SchemaDriftError(ID, `Distributions row ${n + 1} has ${declared} cells but ${cells.length} readable values`);
    rows.push(cells);
  }
  return rows;
}

export type IsharesDistributions = { records: SourceCashDividend[]; zeroDates: IsoDate[] };

export function parseIsharesDistributions(bytes: Uint8Array, opts: { entityId: string; fundName: string; locator: string }): IsharesDistributions {
  const entityId = opts.entityId.trim().toUpperCase();
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!text.includes("<ss:Workbook")) throw new SchemaDriftError(ID, "not an iShares SpreadsheetML workbook");
  // The fund's full name is a cell of its own near the top of the holdings sheet.
  const wantName = `>${opts.fundName.trim()}<`;
  if (!text.includes(wantName)) throw new SchemaDriftError(ID, `the workbook does not name ${opts.fundName}; refusing a file for another fund`);

  const start = text.indexOf('<ss:Worksheet ss:Name="Distributions"');
  if (start < 0) throw new SchemaDriftError(ID, "no Distributions worksheet");
  const end = text.indexOf("</ss:Worksheet>", start);
  if (end < 0) throw new SchemaDriftError(ID, "the Distributions worksheet is not closed");
  const rows = rowsOf(text.slice(start, end));

  const header = rows[0] ?? [];
  const exCol = header.indexOf("Ex-Date");
  const payCol = header.indexOf("Payable Date");
  const totalCol = header.indexOf("Total Distribution");
  if (exCol < 0 || payCol < 0 || totalCol < 0) throw new SchemaDriftError(ID, "the Distributions header does not name Ex-Date, Payable Date and Total Distribution");

  const records: SourceCashDividend[] = [];
  const zeroDates: IsoDate[] = [];
  const seen = new Set<IsoDate>();
  for (const [i, cells] of rows.slice(1).entries()) {
    if (cells.every((c) => c === "")) continue;
    const exText = cells[exCol] ?? "";
    const exDate = monthDayYearDate(exText);
    if (exDate === undefined) throw new SchemaDriftError(ID, `row ${i + 2} has an unreadable ex-date "${exText}"`);
    if (seen.has(exDate)) throw new SchemaDriftError(ID, `${exDate} is listed twice`);
    seen.add(exDate);
    let amount: Dec;
    try {
      amount = new Dec(decimalString(cells[totalCol] ?? ""));
    } catch {
      throw new SchemaDriftError(ID, `${exDate} has an unreadable total distribution "${cells[totalCol] ?? ""}"`);
    }
    if (amount.isNegative()) throw new SchemaDriftError(ID, `${exDate} has a negative total distribution`);
    if (amount.isZero()) {
      zeroDates.push(exDate);
      continue;
    }
    const payText = cells[payCol] ?? "";
    const payDate = payText === "" ? undefined : monthDayYearDate(payText);
    if (payText !== "" && payDate === undefined) throw new SchemaDriftError(ID, `${exDate} has an unreadable payable date "${payText}"`);
    if (payDate !== undefined && payDate < exDate) throw new SchemaDriftError(ID, `${exDate} is payable ${payDate}, before its ex-date`);
    records.push({ source: ISHARES_DISTRIBUTIONS_SOURCE, kind: "CASH_DIVIDEND", entityId, exDate, amount, payDate, locator: `${opts.locator}#${entityId}/${exDate}` });
  }
  records.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  zeroDates.sort();
  return { records, zeroDates };
}
