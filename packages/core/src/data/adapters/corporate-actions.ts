import { compareInstants, hashJson, sha256Hex, utc, type UtcInstant } from "@blackgold/shared";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { PointInTimeObservation } from "../pit/types.ts";
import {
  actionEffectiveDate,
  actionEntityId,
  corporateActionFromValue,
  corporateActionObservation,
  dateStartUtc,
  unreadActionKeys,
  unvaluedActionReason,
} from "../../market/types.ts";
import { SchemaDriftError, type AdapterContext, type FetchOutcome, type ParseContext } from "./common.ts";

/**
 * Vendored corporate-action ingest (D-29). Corporate actions (dividends, splits, spin-offs, ...) are the
 * ledger the adjusted total-return series is built from; without them the research kernel produces a
 * price-return artifact. Alpaca's free bars are raw and carry no actions, and no issuer distribution feed is
 * verified yet (docs/CAPABILITY_REGISTER.md, docs/ASSUMPTIONS_AND_GAPS.md), so until one is, D-29 loads the
 * actions as ordinary point-in-time observations from an operator-curated file that has been reconciled
 * across at least two independent public sources. `docs/PHASE2_REQUIREMENTS_MATRIX.md` names the XLF/XLRE
 * 2015 spin-off as the acceptance case; `config/examples/corporate-actions.example.json` shows the format.
 *
 * This adapter never touches the network. It reads a local file (bytes passed in), stores it as a
 * content-addressed artifact for reproducibility, and turns each entry into a `corporate_action.<KIND>`
 * observation with correct provenance. The `action` object is exactly the stored value shape, so it is
 * validated by `corporateActionFromValue` - the same strict parser the read path uses - rather than a second,
 * drifting validator.
 *
 * **Owner approval is required (D-57).** A file is ingested only when its `approval` block is signed and its
 * `actionsHash` is the hash of the `actions` it carries. Since D-57 the ≥2-source file may be machine-reconciled
 * rather than hand-curated, and the point of the operator-curated rule survives only if nothing becomes evidence
 * until the owner has audited it: so an unsigned file, an approval dated after the ingest, or actions that no
 * longer hash to what was approved all refuse the whole file before a single observation is produced. The
 * reconciler pre-fills `actionsHash`; the owner fills `approvedBy` and `approvedAt`, and Claude Code never does.
 */
export const ADAPTER_VERSION = "1.1.0";
/**
 * 1.1.0 added the approval gate. 1.2.0 refuses an action field its kind does not read, and an action the
 * total-return series cannot value: a SPINOFF without `childFirstClose`, a MERGER paying stock, a DELISTING with no
 * stated final price (D-58).
 */
export const PARSER_VERSION = "1.2.0";

/** Label for SchemaDrift errors; the per-action source id is `corporate_action.<KIND>` from the model. */
const SOURCE_KIND = "corporate_action.vendored";

/** Set on an observation whose vendored entry names fewer than two reconciling sources (D-29). */
export const UNVERIFIED_SINGLE_SOURCE = "UNVERIFIED_SINGLE_SOURCE";

export type CorporateActionsContext = AdapterContext & { dataset?: string | undefined };
export type CorporateActionsParseContext = ParseContext & { dataset?: string | undefined };

// `.strict()` on both objects: an unknown key (a misspelled `announcedAt` as `announced_at`, say) is a
// SCHEMA_DRIFT, not a silently dropped field. Silently dropping a mistyped announcement would fall back to the
// ex-date start and could expose an action before its real, later announcement.
const EntrySchema = z
  .object({
    /** The action in stored form (docs/DATA_PROVENANCE_SPEC.md section 5); validated by corporateActionFromValue. */
    action: z.record(z.string(), z.unknown()),
    /**
     * Announcement / first-public-record instant. Optional. The repository forbids availableAt earlier than the
     * ex/effective date, so an announcement before the ex-date is clamped up to the ex-date start; a later
     * announcement (rare) is honoured. Absent means "available at the ex-date start".
     */
    announcedAt: z.string().optional(),
    /** Distinct public sources this entry was reconciled against. Fewer than two flags UNVERIFIED_SINGLE_SOURCE. */
    sources: z.array(z.string().min(1)).default([]),
  })
  .strict();

const ApprovalSchema = z
  .object({
    /** The owner's name. `null` until he signs; never filled by Claude Code. */
    approvedBy: z.string().nullable(),
    /** ISO-8601 UTC instant of the signature. `null` until he signs. */
    approvedAt: z.string().nullable(),
    /** `corporateActionsHash` of `actions` as approved. Any later edit to an action stops the file ingesting. */
    actionsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex>"),
  })
  .strict();

const FileSchema = z
  .object({
    /** Identifies the vendored set; part of each observation locator so multiple files coexist without collision. */
    dataset: z.string().min(1),
    notes: z.string().optional(),
    /** Required: the owner's sign-off on exactly these actions (D-57). */
    approval: ApprovalSchema,
    actions: z.array(EntrySchema),
  })
  .strict();

/**
 * The hash an approval binds to: sha256 of the canonical JSON of the file's `actions` array, exactly as written
 * (before any schema default is applied), so the reconciler that writes the file and the ingest that checks it
 * hash the same bytes' meaning.
 */
export function corporateActionsHash(actions: unknown): string {
  return `sha256:${hashJson(actions)}`;
}

/** The file is not signed, or its signature does not cover what it now contains (D-57). Nothing is ingested. */
export class UnapprovedCorporateActionsError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`Corporate-actions file is not owner-approved for ingest: ${reasons.join("; ")}`);
    this.name = "UnapprovedCorporateActionsError";
    this.reasons = reasons;
  }
}

function approvalProblems(approval: z.infer<typeof ApprovalSchema>, rawActions: unknown, ingestedAt: UtcInstant): string[] {
  const reasons: string[] = [];
  if (approval.approvedBy === null || approval.approvedBy.trim() === "") reasons.push("approval.approvedBy is unsigned");
  if (approval.approvedAt === null) {
    reasons.push("approval.approvedAt is empty");
  } else {
    let at: UtcInstant | undefined;
    try {
      at = utc(approval.approvedAt);
    } catch {
      reasons.push("approval.approvedAt must be an ISO-8601 UTC instant ending in Z");
    }
    if (at !== undefined && compareInstants(at, ingestedAt) > 0) {
      reasons.push(`approval.approvedAt ${approval.approvedAt} is after this ingest (${ingestedAt}); an approval cannot cover an ingest that precedes it`);
    }
  }
  const actual = corporateActionsHash(rawActions);
  if (actual !== approval.actionsHash) reasons.push(`the actions hash to ${actual}, not the approved ${approval.actionsHash}: they changed after approval`);
  return reasons;
}

/** availableAt = max(announcedAt, exDateStart); the repository rejects anything earlier than the effective date. */
function resolveAvailableAt(announcedAt: string | undefined, effectiveStart: UtcInstant): UtcInstant {
  if (announcedAt === undefined) return effectiveStart;
  const announced = utc(announcedAt);
  return compareInstants(announced, effectiveStart) >= 0 ? announced : effectiveStart;
}

/**
 * Pure: vendored file bytes -> corporate-action observations. Locator
 * `vendor/corporate-actions/<dataset>/<entity>/<KIND>/<effective date>` is unique per action; a collision in
 * one file is a data error (SCHEMA_DRIFT), never a silent overwrite.
 */
export function parseCorporateActions(bytes: Uint8Array, ctx: CorporateActionsParseContext): PointInTimeObservation<Record<string, unknown>>[] {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  } catch (err) {
    throw new SchemaDriftError(SOURCE_KIND, `payload is not JSON (${err instanceof Error ? err.message : "parse error"})`);
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) throw new SchemaDriftError(SOURCE_KIND, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  // Before any action is read: an unapproved file produces no observations at all, not a partial set.
  const problems = approvalProblems(parsed.data.approval, (json as { actions: unknown }).actions, ctx.ingestedAt);
  if (problems.length > 0) throw new UnapprovedCorporateActionsError(problems);
  const dataset = ctx.dataset ?? parsed.data.dataset;

  const seen = new Set<string>();
  return parsed.data.actions.map((entry, i) => {
    let action;
    try {
      action = corporateActionFromValue(entry.action);
    } catch (err) {
      throw new SchemaDriftError(SOURCE_KIND, `actions[${i}]: ${err instanceof Error ? err.message : "malformed action"}`);
    }
    // A field the parser does not read is a typo until shown otherwise; dropping it silently could drop a value.
    const unread = unreadActionKeys(entry.action, action);
    if (unread.length > 0) throw new SchemaDriftError(SOURCE_KIND, `actions[${i}]: a ${action.kind} has no field ${unread.join(", ")}`);
    // An action the total-return series would only warn about - and so value wrongly - is refused.
    const unvalued = unvaluedActionReason(action);
    if (unvalued !== undefined) throw new SchemaDriftError(SOURCE_KIND, `actions[${i}]: ${unvalued}`);
    const entityId = actionEntityId(action);
    const effectiveDate = actionEffectiveDate(action);
    const locator = `vendor/corporate-actions/${dataset}/${entityId}/${action.kind}/${effectiveDate}`;
    if (seen.has(locator)) throw new SchemaDriftError(SOURCE_KIND, `duplicate action ${locator} (same entity, kind and effective date twice in one file)`);
    seen.add(locator);
    // Count distinct source identifiers: ["issuer:x", "issuer:x"] is one source, not two.
    const qualityFlags = new Set(entry.sources).size < 2 ? [UNVERIFIED_SINGLE_SOURCE] : [];
    return corporateActionObservation(action, {
      sourceLocator: locator,
      availableAt: resolveAvailableAt(entry.announcedAt, dateStartUtc(effectiveDate)),
      ingestedAt: ctx.ingestedAt,
      rawContentHash: ctx.rawContentHash,
      adapterVersion: ADAPTER_VERSION,
      parserVersion: PARSER_VERSION,
      qualityFlags,
    });
  });
}

/**
 * Parse the vendored file into observations, then store it as one content-addressed artifact. No network. The
 * whole file shares one rawContentHash, so a re-ingest of the identical file deduplicates end to end.
 *
 * Parsing comes first so a refused file - unapproved, or failing validation - leaves nothing behind, not even an
 * artifact. The hash is the store's own (`sha256:` of the raw bytes), so the observations carry the hash the
 * artifact is then stored under.
 */
export function ingestCorporateActions(store: ArtifactStore, bytes: Uint8Array, ctx: CorporateActionsContext): FetchOutcome<Record<string, unknown>> {
  const parseCtx: CorporateActionsParseContext = { calendar: ctx.calendar, ingestedAt: ctx.ingestedAt, rawContentHash: `sha256:${sha256Hex(bytes)}` };
  if (ctx.dataset !== undefined) parseCtx.dataset = ctx.dataset;
  const observations = parseCorporateActions(bytes, parseCtx);
  const put = store.put(bytes, { locator: "vendor/corporate-actions", mime: "application/json", retention: "market" });
  return { artifacts: [{ hash: put.hash, locator: "vendor/corporate-actions", deduplicated: put.deduplicated, bytesRaw: put.bytesRaw }], observations };
}
