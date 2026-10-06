import { Dec, type IsoDate } from "@blackgold/shared";
import { z } from "zod";
import type { SourceCashDividend } from "../corporate-actions-reconcile.ts";
import { decimalString, SchemaDriftError } from "./common.ts";
import { plainIsoDate } from "./issuer-dates.ts";

/**
 * Vanguard ETF distribution records from a file the OWNER downloaded (D-58). Never fetched by code: Vanguard's
 * terms bar repeated automated access. The file is the JSON array the advisor site serves for one fund
 * (`/investments/products/api/funds/<portId>/pricing/distributions`), saved from a browser. It holds the latest
 * 40 distributions only, which reaches back to late 2016; earlier ones are owner-curated.
 *
 * Each element is one component (`typeCode` INC for income, others for capital gains) going ex on
 * `exDividendDate`; a record's amount sums every component on that date. Zero totals are not distributions.
 *
 * **The file does not name its fund**, so the entity comes from the operator, and a file saved under the wrong
 * fund cannot be caught here. It is caught by reconciliation: its amounts disagree with the vendor's for the fund
 * it is attributed to, on every date, and each disagreement is reported.
 *
 * Amounts arrive as JSON numbers. JavaScript prints a parsed number back as its shortest round-trip decimal, which
 * recovers the published figure for anything with fewer than 16 significant digits - every per-share amount - so
 * nothing passes through binary arithmetic.
 */
export const VANGUARD_DISTRIBUTIONS_SOURCE = "issuer:vanguard-distributions";
export const VANGUARD_DISTRIBUTIONS_PARSER_VERSION = "1.0.0";

const ID = "issuer.vanguard.distributions";

// Not strict: the rows carry record and reinvestment fields this does not read.
const RowSchema = z.object({
  typeCode: z.string().min(1),
  amount: z.union([z.number(), z.string()]),
  exDividendDate: z.string(),
  payableDate: z.string().optional(),
});

export type VanguardDistributions = { records: SourceCashDividend[]; zeroDates: IsoDate[] };

export function parseVanguardDistributions(bytes: Uint8Array, opts: { entityId: string; locator: string }): VanguardDistributions {
  const entityId = opts.entityId.trim().toUpperCase();
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (err) {
    throw new SchemaDriftError(ID, `not JSON (${err instanceof Error ? err.message : "parse error"})`);
  }
  const parsed = z.array(RowSchema).safeParse(json);
  if (!parsed.success) throw new SchemaDriftError(ID, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (parsed.data.length === 0) throw new SchemaDriftError(ID, `the file for ${entityId} lists no distributions`);

  const byDate = new Map<IsoDate, { amount: Dec; payDate: IsoDate | undefined; codes: Set<string> }>();
  for (const [i, row] of parsed.data.entries()) {
    const exDate = plainIsoDate(row.exDividendDate);
    if (exDate === undefined) throw new SchemaDriftError(ID, `[${i}] has an unreadable exDividendDate "${row.exDividendDate}"`);
    let amount: Dec;
    try {
      amount = new Dec(decimalString(row.amount));
    } catch {
      throw new SchemaDriftError(ID, `[${i}] ${exDate} has an unreadable amount`);
    }
    if (amount.isNegative()) throw new SchemaDriftError(ID, `[${i}] ${exDate} has a negative amount`);
    const payDate = row.payableDate === undefined || row.payableDate === "" ? undefined : plainIsoDate(row.payableDate);
    if (row.payableDate !== undefined && row.payableDate !== "" && payDate === undefined) throw new SchemaDriftError(ID, `[${i}] ${exDate} has an unreadable payableDate`);
    if (payDate !== undefined && payDate < exDate) throw new SchemaDriftError(ID, `[${i}] ${exDate} is payable ${payDate}, before its ex-date`);
    const day = byDate.get(exDate) ?? { amount: new Dec(0), payDate, codes: new Set<string>() };
    // Two components of one type on one date is a duplicated row, not a second payment: refuse to sum it.
    if (day.codes.has(row.typeCode)) throw new SchemaDriftError(ID, `${exDate} lists ${row.typeCode} twice`);
    if (day.payDate !== payDate) throw new SchemaDriftError(ID, `${exDate}'s components name different payable dates`);
    day.codes.add(row.typeCode);
    day.amount = day.amount.plus(amount);
    byDate.set(exDate, day);
  }

  const records: SourceCashDividend[] = [];
  const zeroDates: IsoDate[] = [];
  for (const exDate of [...byDate.keys()].sort()) {
    const day = byDate.get(exDate);
    if (day === undefined) continue;
    if (day.amount.isZero()) {
      zeroDates.push(exDate);
      continue;
    }
    records.push({ source: VANGUARD_DISTRIBUTIONS_SOURCE, kind: "CASH_DIVIDEND", entityId, exDate, amount: day.amount, payDate: day.payDate, locator: `${opts.locator}#${entityId}/${exDate}` });
  }
  return { records, zeroDates };
}
