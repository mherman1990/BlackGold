import { Dec, isoDate, utc, type IsoDate } from "@blackgold/shared";
import { z } from "zod";
import type { RecordSelector, SourceAction, StructuralEntry } from "./corporate-actions-reconcile.ts";
import { plainIsoDate } from "./adapters/issuer-dates.ts";
import { ISHARES_DISTRIBUTIONS_SOURCE } from "./adapters/ishares-distributions.ts";
import { SSGA_DISTRIBUTIONS_SOURCE, SSGA_NAV_HISTORY_SOURCE } from "./adapters/ssga-distributions.ts";
import { VANGUARD_DISTRIBUTIONS_SOURCE } from "./adapters/vanguard-distributions.ts";

/**
 * Owner-curated corporate actions (D-58): the distributions and splits no issuer feed reaches - VTI, VTV and VUG
 * before late 2016, all of QQQ - which the owner records by hand from the issuers' own documents, plus the
 * structural actions (spin-offs, mergers, delistings) that only a person can read correctly.
 *
 * **Cash and split rows are a CSV**, so they can be typed in a spreadsheet, one row per distribution:
 *
 *     source,entity,kind,ex_date,value,pay_date,document
 *     issuer:vanguard-annual-report,VTI,CASH_DIVIDEND,2010-03-24,0.4900,2010-03-29,"Annual report 2010, p. 14"
 *
 * - `source` names who published the document: `issuer:<name>` or `exchange:<name>`. It may not be a name an
 *   automated adapter uses, so a typed row can never pass for a fetched one and make a single source look like two.
 * - `value` is the total cash per share (every component summed), or new shares per old share for a SPLIT.
 * - `pay_date` is optional and only for cash. `document` is required: it is the record's locator in the report,
 *   and the owner's audit trail back to the page the number came from.
 * - Blank lines and lines starting with `#` are ignored. Fields containing commas are double-quoted.
 *
 * **Structural actions are JSON**, in the vendored file's own entry shape (`{ "actions": [{ action, sources,
 * announcedAt?, supersedes?, keeps? }] }`), because each kind has its own fields; the reconciler writes `action`,
 * `sources` and `announcedAt` as given. `supersedes` and `keeps` classify every cash or split record any source
 * reports on the same entity and date, by `{ source, kind }`: superseded ones are the structural action in another
 * guise and are set aside; kept ones are separate actions and are reconciled. An unclassified one stops the run. A
 * MERGER or DELISTING also classifies every record dated after the entity's last bar, naming each with an `exDate`,
 * and may only supersede them.
 *
 * Every row is checked and every problem is reported at once, with its line, so an 80-row file is fixed in one
 * pass. Nothing here invents a value: a row the parser cannot read is an error, never a default.
 */
export const CURATED_HEADER = ["source", "entity", "kind", "ex_date", "value", "pay_date", "document"] as const;

/** Source names automated adapters write; a curated row may not borrow one. */
export const AUTOMATED_SOURCES: ReadonlySet<string> = new Set([
  SSGA_DISTRIBUTIONS_SOURCE,
  SSGA_NAV_HISTORY_SOURCE,
  VANGUARD_DISTRIBUTIONS_SOURCE,
  ISHARES_DISTRIBUTIONS_SOURCE,
]);

const SOURCE_RE = /^(issuer|exchange):[a-z0-9][a-z0-9-]*$/;
const ENTITY_RE = /^[A-Z][A-Z.-]{0,9}$/;

export class CuratedInputError extends Error {
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`${file}: ${problems.length} problem(s): ${problems.join("; ")}`);
    this.name = "CuratedInputError";
    this.problems = problems;
  }
}

/** RFC 4180 records: comma-separated, optional double quotes with "" as an escaped quote, LF or CRLF. */
function csvRecords(text: string): { line: number; fields: string[] }[] {
  const out: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") i++;
      fields.push(field);
      out.push({ line: startLine, fields });
      fields = [];
      field = "";
      line++;
      startLine = line;
    } else field += ch;
  }
  if (quoted) throw new CuratedInputError("curated CSV", [`line ${startLine}: a quoted field is never closed`]);
  if (field !== "" || fields.length > 0) {
    fields.push(field);
    out.push({ line: startLine, fields });
  }
  return out;
}

/** Parse the curated CSV into reconciliation records. Throws `CuratedInputError` naming every bad line. */
export function parseCuratedActions(bytes: Uint8Array, opts: { file: string }): SourceAction[] {
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  // A spreadsheet's empty rows export as a line of bare commas; they are blank lines too.
  const rows = csvRecords(text).filter((r) => r.fields.some((f) => f.trim() !== "") && !r.fields[0]?.trim().startsWith("#"));
  const header = rows.shift();
  const problems: string[] = [];
  if (header?.fields.map((f) => f.trim().toLowerCase()).join(",") !== CURATED_HEADER.join(",")) {
    throw new CuratedInputError(opts.file, [`the first row must be exactly: ${CURATED_HEADER.join(",")}`]);
  }

  const records: SourceAction[] = [];
  const seen = new Set<string>();
  for (const { line, fields } of rows) {
    const at = `line ${line}`;
    if (fields.length !== CURATED_HEADER.length) {
      problems.push(`${at}: ${fields.length} fields, expected ${CURATED_HEADER.length}`);
      continue;
    }
    const [source = "", entityRaw = "", kind = "", exText = "", valueText = "", payText = "", document = ""] = fields.map((f) => f.trim());
    const entityId = entityRaw.toUpperCase();
    const before = problems.length;
    if (!SOURCE_RE.test(source)) problems.push(`${at}: source "${source}" must look like issuer:<name> or exchange:<name>`);
    else if (AUTOMATED_SOURCES.has(source)) problems.push(`${at}: source "${source}" is an automated adapter's; name the document's publisher differently`);
    if (!ENTITY_RE.test(entityId)) problems.push(`${at}: entity "${entityRaw}" is not a ticker`);
    if (kind !== "CASH_DIVIDEND" && kind !== "SPLIT") problems.push(`${at}: kind "${kind}" must be CASH_DIVIDEND or SPLIT (structural actions go in the JSON file)`);
    const exDate = plainIsoDate(exText);
    if (exDate === undefined) problems.push(`${at}: ex_date "${exText}" is not a YYYY-MM-DD date`);
    let value: Dec | undefined;
    try {
      value = new Dec(valueText);
      if (!/^\d+(\.\d+)?$/.test(valueText) || !value.isPositive()) throw new Error("not positive");
    } catch {
      problems.push(`${at}: value "${valueText}" must be a positive decimal`);
      value = undefined;
    }
    let payDate: IsoDate | undefined;
    if (payText !== "") {
      payDate = plainIsoDate(payText);
      if (kind === "SPLIT") problems.push(`${at}: a SPLIT has no pay_date`);
      else if (payDate === undefined) problems.push(`${at}: pay_date "${payText}" is not a YYYY-MM-DD date`);
      else if (exDate !== undefined && payDate < exDate) problems.push(`${at}: pay_date ${payDate} precedes ex_date ${exDate}`);
    }
    if (document === "") problems.push(`${at}: document is required - it is how the number is audited`);
    if (problems.length > before || exDate === undefined || value === undefined) continue;
    const key = `${source}|${entityId}|${kind}|${exDate}`;
    if (seen.has(key)) {
      problems.push(`${at}: ${entityId} ${kind} ${exDate} from ${source} is already listed; sum a distribution's components into one row`);
      continue;
    }
    seen.add(key);
    const locator = `${opts.file}:${line} ${document}`;
    records.push(
      kind === "CASH_DIVIDEND"
        ? { source, kind, entityId, exDate, amount: value, payDate, locator }
        : { source, kind: "SPLIT", entityId, exDate, ratio: value, locator },
    );
  }
  if (problems.length > 0) throw new CuratedInputError(opts.file, problems);
  return records;
}

const SelectorSchema = z
  .object({
    source: z.string().regex(/^(issuer|exchange|vendor):[a-z0-9][a-z0-9-]*$/, "must look like issuer:, exchange: or vendor:<name>"),
    kind: z.enum(["CASH_DIVIDEND", "SPLIT"]),
    exDate: z.string().refine((d) => plainIsoDate(d) === d, "must be a YYYY-MM-DD date").optional(),
  })
  .strict();

const StructuralFileSchema = z
  .object({
    notes: z.string().optional(),
    actions: z.array(
      z
        .object({
          action: z.record(z.string(), z.unknown()),
          sources: z.array(z.string().regex(SOURCE_RE, "must look like issuer:<name> or exchange:<name>")).min(1),
          announcedAt: z.string().optional(),
          supersedes: z.array(SelectorSchema).optional(),
          keeps: z.array(SelectorSchema).optional(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Parse the curated structural-actions JSON. The reconciler validates each `action` and writes it as given; this
 * checks the envelope, the source names, and that any `announcedAt` is a UTC instant.
 */
export function parseCuratedStructural(bytes: Uint8Array, opts: { file: string }): StructuralEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (err) {
    throw new CuratedInputError(opts.file, [`not JSON (${err instanceof Error ? err.message : "parse error"})`]);
  }
  const parsed = StructuralFileSchema.safeParse(json);
  if (!parsed.success) throw new CuratedInputError(opts.file, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const problems: string[] = [];
  for (const [i, e] of parsed.data.actions.entries()) {
    if (e.announcedAt === undefined) continue;
    try {
      utc(e.announcedAt);
    } catch {
      problems.push(`actions.${i}.announcedAt "${e.announcedAt}" is not a UTC instant`);
    }
  }
  if (problems.length > 0) throw new CuratedInputError(opts.file, problems);
  const selectors = (list: z.infer<typeof SelectorSchema>[]): RecordSelector[] =>
    list.map((r) => ({ source: r.source, kind: r.kind, ...(r.exDate === undefined ? {} : { exDate: isoDate(r.exDate) }) }));
  return parsed.data.actions.map((e) => ({
    action: e.action,
    sources: e.sources,
    ...(e.announcedAt === undefined ? {} : { announcedAt: e.announcedAt }),
    ...(e.supersedes === undefined ? {} : { supersedes: selectors(e.supersedes) }),
    ...(e.keeps === undefined ? {} : { keeps: selectors(e.keeps) }),
  }));
}
