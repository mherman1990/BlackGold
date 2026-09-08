import { compareInstants, utc, type UtcInstant } from "@blackgold/shared";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { PointInTimeObservation } from "../pit/types.ts";
import {
  actionEffectiveDate,
  actionEntityId,
  corporateActionFromValue,
  corporateActionObservation,
  dateStartUtc,
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
 */
export const ADAPTER_VERSION = "1.0.0";
export const PARSER_VERSION = "1.0.0";

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

const FileSchema = z
  .object({
    /** Identifies the vendored set; part of each observation locator so multiple files coexist without collision. */
    dataset: z.string().min(1),
    notes: z.string().optional(),
    actions: z.array(EntrySchema),
  })
  .strict();

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
  const dataset = ctx.dataset ?? parsed.data.dataset;

  const seen = new Set<string>();
  return parsed.data.actions.map((entry, i) => {
    let action;
    try {
      action = corporateActionFromValue(entry.action);
    } catch (err) {
      throw new SchemaDriftError(SOURCE_KIND, `actions[${i}]: ${err instanceof Error ? err.message : "malformed action"}`);
    }
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
 * Store the vendored file as one content-addressed artifact and parse it into observations. No network. The
 * whole file shares one rawContentHash, so a re-ingest of the identical file deduplicates end to end.
 */
export function ingestCorporateActions(store: ArtifactStore, bytes: Uint8Array, ctx: CorporateActionsContext): FetchOutcome<Record<string, unknown>> {
  const put = store.put(bytes, { locator: "vendor/corporate-actions", mime: "application/json", retention: "market" });
  const parseCtx: CorporateActionsParseContext = { calendar: ctx.calendar, ingestedAt: ctx.ingestedAt, rawContentHash: put.hash };
  if (ctx.dataset !== undefined) parseCtx.dataset = ctx.dataset;
  const observations = parseCorporateActions(bytes, parseCtx);
  return { artifacts: [{ hash: put.hash, locator: "vendor/corporate-actions", deduplicated: put.deduplicated, bytesRaw: put.bytesRaw }], observations };
}
