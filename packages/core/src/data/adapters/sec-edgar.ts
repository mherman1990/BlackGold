import { isoDate, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { z } from "zod";
import { MissingSourceCredentialError } from "../../errors.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { AllowlistedHttpClient } from "../http.ts";
import { form4Flags, parseEdgarAcceptance, secDissemination } from "../lag-rules.ts";
import type { PointInTimeObservation } from "../pit/types.ts";
import {
  baseObservation,
  canonicalAccession,
  decodeUtf8,
  fetchAndStore,
  idForCik,
  midnightUtc,
  optionalDecimalString,
  padCik,
  parseJsonBytes,
  SchemaDriftError,
  type AdapterContext,
  type FetchOutcome,
  type ParseContext,
} from "./common.ts";

/**
 * SEC EDGAR adapter (docs/DATA_PROVENANCE_SPEC.md section 3, "SEC EDGAR" and "Form 4").
 *
 * - Submissions index: https://data.sec.gov/submissions/CIK##########.json, one observation per filing.
 *   availableAt is the dissemination instant derived from acceptanceDateTime by `secDissemination`.
 * - Form 4 primary documents (XML): one observation per non-derivative transaction, observedAt = transaction
 *   date, flags from `form4Flags` (AFTER_HOURS_ACCEPTANCE, LATE_FILING) plus AMENDED for 4/A.
 * Fair access: the injected client carries the declared User-Agent and the global rate limit; this module
 * refuses to run without a configured contact so an anonymous request can never be built.
 */
export const ADAPTER_VERSION = "1.0.0";
export const PARSER_VERSION = "1.0.0";
const VERSIONS = { adapterVersion: ADAPTER_VERSION, parserVersion: PARSER_VERSION };

export const SEC_SUBMISSIONS_SOURCE_ID = "sec.edgar.submissions";
export const SEC_FORM4_SOURCE_ID = "sec.edgar.form4";

export type FilingIndexEntry = {
  cik: string;
  entityName: string | null;
  accessionNumber: string;
  form: string;
  isAmendment: boolean;
  filingDate: IsoDate;
  reportDate: IsoDate | null;
  /** EDGAR acceptance converted to UTC (the raw field is Eastern wall-clock). */
  acceptanceAt: UtcInstant;
  primaryDocument: string | null;
  primaryDocDescription: string | null;
  isXbrl: boolean;
  isInlineXbrl: boolean;
  items: string | null;
  sizeBytes: number | null;
};

export type Form4Transaction = {
  accessionNumber: string;
  form: string;
  issuerCik: string;
  issuerTradingSymbol: string | null;
  reportingOwnerCik: string;
  securityTitle: string | null;
  transactionDate: IsoDate;
  transactionCode: string;
  /** Share count as a canonical decimal string. */
  shares: string;
  pricePerShare: string | null;
  acquiredDisposed: "A" | "D";
  sharesOwnedAfter: string | null;
  directOrIndirect: string | null;
  isDerivative: false;
  /** From the 10b5-1 checkbox when the schema carries one; null when absent. */
  is10b51: boolean | null;
};

export type SecSubmissionsContext = AdapterContext & { userAgentContact?: string | undefined };

export function submissionsUrl(cik: string | number): string {
  return `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`;
}

/** Archive URL of a primary document: Archives/edgar/data/<cik without zeros>/<accession without dashes>/<doc>. */
export function primaryDocumentUrl(cik: string | number, accessionNumber: string, primaryDocument: string): string {
  const acc = canonicalAccession(accessionNumber).replaceAll("-", "");
  const cikInt = padCik(cik).replace(/^0+/, "") || "0";
  if (!/^[A-Za-z0-9._-]+$/.test(primaryDocument)) throw new TypeError(`Unsafe primary document name: ${primaryDocument}`);
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${acc}/${primaryDocument}`;
}

export async function fetchSubmissions(
  client: AllowlistedHttpClient,
  store: ArtifactStore,
  cik: string | number,
  ctx: SecSubmissionsContext,
): Promise<FetchOutcome<FilingIndexEntry>> {
  if (ctx.userAgentContact === undefined || ctx.userAgentContact.trim() === "") {
    throw new MissingSourceCredentialError(SEC_SUBMISSIONS_SOURCE_ID, "secUserAgentContact");
  }
  const url = submissionsUrl(cik);
  const { put, ref } = await fetchAndStore(client, store, url, { locator: url, mime: "application/json", retention: "filings" });
  const bytes = store.get(put.hash);
  const observations = parseSubmissions(bytes, { calendar: ctx.calendar, ingestedAt: ctx.ingestedAt, rawContentHash: put.hash });
  return { artifacts: [ref], observations };
}

export type Form4DocumentContext = SecSubmissionsContext & {
  cik: string | number;
  accessionNumber: string;
  primaryDocument: string;
  /** Acceptance instant from the submissions index; the XML itself does not carry it. */
  acceptanceAt: UtcInstant;
  form: string;
};

export async function fetchForm4Document(
  client: AllowlistedHttpClient,
  store: ArtifactStore,
  ctx: Form4DocumentContext,
): Promise<FetchOutcome<Form4Transaction>> {
  if (ctx.userAgentContact === undefined || ctx.userAgentContact.trim() === "") {
    throw new MissingSourceCredentialError(SEC_FORM4_SOURCE_ID, "secUserAgentContact");
  }
  const url = primaryDocumentUrl(ctx.cik, ctx.accessionNumber, ctx.primaryDocument);
  const { put, ref } = await fetchAndStore(client, store, url, { locator: url, mime: "application/xml", retention: "filings" });
  const bytes = store.get(put.hash);
  const observations = parseForm4Xml(bytes, {
    calendar: ctx.calendar,
    ingestedAt: ctx.ingestedAt,
    rawContentHash: put.hash,
    accessionNumber: ctx.accessionNumber,
    acceptanceAt: ctx.acceptanceAt,
    form: ctx.form,
  });
  return { artifacts: [ref], observations };
}

// ---------------------------------------------------------------------------------------------
// Submissions index parser
// ---------------------------------------------------------------------------------------------

const strArray = z.array(z.string());
const RecentSchema = z.object({
  accessionNumber: strArray,
  filingDate: strArray,
  reportDate: strArray,
  acceptanceDateTime: strArray,
  form: strArray,
  primaryDocument: strArray.optional(),
  primaryDocDescription: strArray.optional(),
  isXBRL: z.array(z.union([z.number(), z.boolean()])).optional(),
  isInlineXBRL: z.array(z.union([z.number(), z.boolean()])).optional(),
  items: strArray.optional(),
  size: z.array(z.number()).optional(),
});
const SubmissionsSchema = z.object({
  cik: z.union([z.string(), z.number()]),
  name: z.string().optional(),
  filings: z.object({ recent: RecentSchema }),
});

function isAmendmentForm(form: string): boolean {
  return form.endsWith("/A");
}

function isForm4(form: string): boolean {
  return form === "4" || form === "4/A";
}

/** Pure: (bytes, ctx, PARSER_VERSION) -> observations. One `sec.edgar.submissions` row per filing, plus a
 *  `sec.edgar.form4` index-level row for each Form 4 / 4-A (observedAt = filing date; the transaction date
 *  lives in the XML, see parseForm4Xml). */
export function parseSubmissions(bytes: Uint8Array, ctx: ParseContext): PointInTimeObservation<FilingIndexEntry>[] {
  const parsed = SubmissionsSchema.safeParse(parseJsonBytes(bytes, SEC_SUBMISSIONS_SOURCE_ID));
  if (!parsed.success) throw new SchemaDriftError(SEC_SUBMISSIONS_SOURCE_ID, parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; "));
  const doc = parsed.data;
  const cik = padCik(doc.cik);
  const entityId = idForCik(cik);
  const r = doc.filings.recent;
  const n = r.accessionNumber.length;
  for (const [name, arr] of Object.entries(r)) {
    if (arr !== undefined && arr.length !== n) throw new SchemaDriftError(SEC_SUBMISSIONS_SOURCE_ID, `filings.recent.${name} has ${arr.length} entries, expected ${n}`);
  }
  const out: PointInTimeObservation<FilingIndexEntry>[] = [];
  for (let i = 0; i < n; i++) {
    const form = r.form[i] ?? "";
    const accessionNumber = canonicalAccession(r.accessionNumber[i] ?? "");
    const filingDate = isoDate(r.filingDate[i] ?? "");
    const reportRaw = r.reportDate[i] ?? "";
    const reportDate = reportRaw === "" ? null : isoDate(reportRaw);
    const acceptanceAt = parseEdgarAcceptance(r.acceptanceDateTime[i] ?? "");
    const lag = secDissemination(acceptanceAt, ctx.calendar);
    const flags = [...lag.flags];
    if (isAmendmentForm(form)) flags.push("AMENDED");
    const value: FilingIndexEntry = {
      cik,
      entityName: doc.name ?? null,
      accessionNumber,
      form,
      isAmendment: isAmendmentForm(form),
      filingDate,
      reportDate,
      acceptanceAt,
      primaryDocument: emptyToNull(r.primaryDocument?.[i]),
      primaryDocDescription: emptyToNull(r.primaryDocDescription?.[i]),
      isXbrl: truthy(r.isXBRL?.[i]),
      isInlineXbrl: truthy(r.isInlineXBRL?.[i]),
      items: emptyToNull(r.items?.[i]),
      sizeBytes: r.size?.[i] ?? null,
    };
    const common = { sourceLocator: accessionNumber, entityId, availableAt: lag.availableAt, value };

    // EDGAR's reportDate is not always a period being reported on. For a proxy statement (DEF 14A) it is the
    // scheduled shareholder MEETING date, which is in the future when the proxy is filed - Apple's 2026 proxy
    // was filed 2026-01-08 for a 2026-02-24 meeting, and 11 of its 772 filings have the same shape. Using it
    // as observedAt claims a fact effective after it was knowable, which the temporal-inversion guard
    // correctly refuses, and which blocked SEC ingest outright for any issuer that files a proxy.
    //
    // A forward reportDate describes what a document announces, not when the document became true. The
    // document became true when it was filed, so observedAt falls back to the filing date and the row carries
    // FORWARD_DATED_REPORT. The raw reportDate is untouched in the value, so nothing is lost and the
    // substitution is visible rather than silent.
    const forwardDated = reportDate !== null && reportDate > filingDate;
    const observedDate = reportDate === null ? null : forwardDated ? filingDate : reportDate;
    const submissionFlags = forwardDated ? [...flags, "FORWARD_DATED_REPORT" as const] : flags;
    out.push(
      baseObservation(
        { sourceId: SEC_SUBMISSIONS_SOURCE_ID, ...common, ...(observedDate === null ? {} : { observedAt: midnightUtc(observedDate) }), qualityFlags: submissionFlags },
        ctx,
        VERSIONS,
      ),
    );
    if (isForm4(form)) {
      // Index-level Form 4 row: the transaction date is only in the XML, so observedAt is the filing date and
      // the flags come from dissemination alone (LATE_FILING needs the transaction date; see parseForm4Xml).
      out.push(baseObservation({ sourceId: SEC_FORM4_SOURCE_ID, ...common, observedAt: midnightUtc(filingDate), qualityFlags: flags }, ctx, VERSIONS));
    }
  }
  return out;
}

function emptyToNull(v: string | undefined): string | null {
  return v === undefined || v === "" ? null : v;
}

function truthy(v: number | boolean | undefined): boolean {
  return v === true || v === 1;
}

// ---------------------------------------------------------------------------------------------
// Form 4 XML parser (ownershipDocument)
// ---------------------------------------------------------------------------------------------

export type Form4ParseContext = ParseContext & { accessionNumber: string; acceptanceAt: UtcInstant; form: string };

/** Pure: one `sec.edgar.form4` observation per nonDerivativeTransaction. Locator: `<accession>/nonDerivativeTransaction/<n>`. */
export function parseForm4Xml(bytes: Uint8Array, ctx: Form4ParseContext): PointInTimeObservation<Form4Transaction>[] {
  const xml = stripComments(decodeUtf8(bytes));
  const doc = firstBlock(xml, "ownershipDocument");
  if (doc === undefined) throw new SchemaDriftError(SEC_FORM4_SOURCE_ID, "no <ownershipDocument> element");
  const issuerBlock = firstBlock(doc, "issuer");
  const issuerCikRaw = issuerBlock === undefined ? undefined : textOf(issuerBlock, "issuerCik");
  if (issuerCikRaw === undefined) throw new SchemaDriftError(SEC_FORM4_SOURCE_ID, "missing issuerCik");
  const issuerCik = padCik(issuerCikRaw);
  const issuerTradingSymbol = issuerBlock === undefined ? undefined : textOf(issuerBlock, "issuerTradingSymbol");
  const ownerBlock = firstBlock(doc, "reportingOwner");
  const ownerCikRaw = ownerBlock === undefined ? undefined : textOf(ownerBlock, "rptOwnerCik");
  if (ownerCikRaw === undefined) throw new SchemaDriftError(SEC_FORM4_SOURCE_ID, "missing rptOwnerCik");
  const reportingOwnerCik = padCik(ownerCikRaw);
  const docLevel10b51 = parseFlag(textOf(doc, "aff10b5One"));
  const accessionNumber = canonicalAccession(ctx.accessionNumber);
  const amended = isAmendmentForm(ctx.form);

  const table = firstBlock(doc, "nonDerivativeTable");
  const transactions = table === undefined ? [] : allBlocks(table, "nonDerivativeTransaction");
  const out: PointInTimeObservation<Form4Transaction>[] = [];
  transactions.forEach((tx, index) => {
    const dateRaw = valueOf(tx, "transactionDate");
    if (dateRaw === undefined) throw new SchemaDriftError(SEC_FORM4_SOURCE_ID, `transaction ${index + 1}: missing transactionDate`);
    const transactionDate = isoDate(dateRaw);
    const coding = firstBlock(tx, "transactionCoding");
    const transactionCode = coding === undefined ? undefined : textOf(coding, "transactionCode");
    if (transactionCode === undefined) throw new SchemaDriftError(SEC_FORM4_SOURCE_ID, `transaction ${index + 1}: missing transactionCode`);
    const amounts = firstBlock(tx, "transactionAmounts");
    const sharesRaw = amounts === undefined ? undefined : valueOf(amounts, "transactionShares");
    if (sharesRaw === undefined) throw new SchemaDriftError(SEC_FORM4_SOURCE_ID, `transaction ${index + 1}: missing transactionShares`);
    const adRaw = amounts === undefined ? undefined : valueOf(amounts, "transactionAcquiredDisposedCode");
    if (adRaw !== "A" && adRaw !== "D") throw new SchemaDriftError(SEC_FORM4_SOURCE_ID, `transaction ${index + 1}: acquiredDisposed must be A or D`);
    const post = firstBlock(tx, "postTransactionAmounts");
    const nature = firstBlock(tx, "ownershipNature");
    const tx10b51 = parseFlag(textOf(tx, "aff10b5One"));
    const lag = form4Flags(transactionDate, ctx.acceptanceAt, ctx.calendar);
    const flags = [...lag.flags];
    if (amended) flags.push("AMENDED");
    const value: Form4Transaction = {
      accessionNumber,
      form: ctx.form,
      issuerCik,
      issuerTradingSymbol: issuerTradingSymbol ?? null,
      reportingOwnerCik,
      securityTitle: valueOf(tx, "securityTitle") ?? null,
      transactionDate,
      transactionCode,
      shares: optionalDecimalString(sharesRaw) ?? "0",
      pricePerShare: optionalDecimalString(amounts === undefined ? undefined : valueOf(amounts, "transactionPricePerShare")),
      acquiredDisposed: adRaw,
      sharesOwnedAfter: optionalDecimalString(post === undefined ? undefined : valueOf(post, "sharesOwnedFollowingTransaction")),
      directOrIndirect: nature === undefined ? null : (valueOf(nature, "directOrIndirectOwnership") ?? null),
      isDerivative: false,
      is10b51: tx10b51 ?? docLevel10b51,
    };
    out.push(
      baseObservation(
        {
          sourceId: SEC_FORM4_SOURCE_ID,
          sourceLocator: `${accessionNumber}/nonDerivativeTransaction/${index + 1}`,
          entityId: idForCik(issuerCik),
          observedAt: midnightUtc(transactionDate),
          availableAt: lag.availableAt,
          value,
          qualityFlags: flags,
        },
        ctx,
        VERSIONS,
      ),
    );
  });
  return out;
}

function parseFlag(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  const t = v.trim().toLowerCase();
  if (t === "1" || t === "true") return true;
  if (t === "0" || t === "false") return false;
  return null;
}

// Minimal, deterministic XML element extraction for EDGAR's flat ownership schema. Elements of the same name
// are never nested inside one another in that schema, so a non-greedy open/close scan is exact.
function stripComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${escapeTag(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTag(tag)}>`, "g");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1] ?? "");
  return out;
}

function firstBlock(xml: string, tag: string): string | undefined {
  return allBlocks(xml, tag)[0];
}

/** Text of the first <tag>text</tag> that has no child elements. */
function textOf(xml: string, tag: string): string | undefined {
  for (const block of allBlocks(xml, tag)) {
    if (!block.includes("<")) return decodeEntities(block.trim());
  }
  return undefined;
}

/** EDGAR wraps most fields as <tag><value>text</value></tag>. */
function valueOf(xml: string, tag: string): string | undefined {
  const block = firstBlock(xml, tag);
  if (block === undefined) return undefined;
  return textOf(block, "value");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}
