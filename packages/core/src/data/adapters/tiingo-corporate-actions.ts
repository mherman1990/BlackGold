import { Dec, isoDate } from "@blackgold/shared";
import { z } from "zod";
import { MissingSourceCredentialError } from "../../errors.ts";
import { corporateActionFromValue, corporateActionObservation, dateStartUtc } from "../../market/types.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { AllowlistedHttpClient } from "../http.ts";
import type { PointInTimeObservation } from "../pit/types.ts";
import {
  decimalString,
  fetchAndStore,
  parseJsonBytes,
  SchemaDriftError,
  type ArtifactRef,
  type FetchOutcome,
  type ParseContext,
} from "./common.ts";
import { UNVERIFIED_SINGLE_SOURCE } from "./corporate-actions.ts";
import { normalizeSymbols, tiingoRequestUrl, type TiingoContext } from "./tiingo.ts";

/**
 * Tiingo corporate actions from the same daily-prices endpoint the bars adapter reads (D-49). Each price row
 * carries `divCash` (raw cash dividend per share on the ex-date) and `splitFactor` (new shares per old share on
 * the ex-date); the bars adapter deliberately ignores both because Black Gold recomputes total return from raw
 * closes plus the corporate-action ledger, and this adapter is that ledger's Tiingo source.
 *
 * Tiingo is a SINGLE public source, so every action it produces is flagged `UNVERIFIED_SINGLE_SOURCE` - usable
 * for research and decisions, never promotion evidence (docs/DECISIONS.md D-29/D-49, `data/quality.ts`). That
 * bar binds because the consumers of corporate actions (features, backtest, coverage) fold each action row's
 * promotion-blocking flags into the trial labels and coverage blocking codes `setPromotionEvidence` checks. This
 * is the automated alternative to the operator-curated, multi-source vendored file in `corporate-actions.ts`;
 * the two share the `corporate_action.<KIND>` source ids and the same strict `corporateActionFromValue`
 * validator, so an operator uses one or the other for a given universe and never both (mixing double-counts a
 * distribution). The reconciled vendored file remains the only promotion-eligible path.
 *
 * Provenance from a prices feed is thin: it names no announcement date and no pay date. So `availableAt` is the
 * ex-date start (the conservative, leakage-safe instant a going-ex action is certainly known by - the real
 * declaration is earlier, never later), `payDate` defaults to the ex-date (the TR series reads only exDate and
 * amount; the repository requires payDate >= exDate), and `qualified` defaults to false (the tax-conservative
 * unknown). The API token travels only in a request header; it never reaches a locator, value, or error.
 *
 * `divCash == 0` and `splitFactor == 1` are the no-action rows and produce nothing. A row may carry both a
 * dividend and a split; both are emitted.
 */
export const ADAPTER_VERSION = "1.0.0";
export const PARSER_VERSION = "1.0.0";

/** Label for SchemaDrift/credential errors; the per-action observation source id is `corporate_action.<KIND>`. */
export const TIINGO_CA_SOURCE_LABEL = "tiingo.corporate-actions";

// divCash and splitFactor are the payload here (not optional as in the bars adapter): a row that omits them is
// SCHEMA_DRIFT, not a silent no-action. The adjusted columns and OHLCV are tolerated and ignored.
const RowSchema = z
  .object({
    date: z.string(),
    divCash: z.union([z.number(), z.string()]),
    splitFactor: z.union([z.number(), z.string()]),
  })
  .catchall(z.unknown());
const RowsSchema = z.array(RowSchema);

export type TiingoCorporateActionsParseContext = ParseContext & {
  symbol: string;
  entityIds?: Readonly<Record<string, string>> | undefined;
};

function toDec(x: number | string, field: string): Dec {
  try {
    return new Dec(decimalString(x));
  } catch (err) {
    throw new SchemaDriftError(TIINGO_CA_SOURCE_LABEL, `${field}: ${err instanceof Error ? err.message : "not a decimal"}`);
  }
}

/**
 * Pure: Tiingo prices rows -> corporate-action observations. Locator
 * `tiingo/corporate-actions/<entity>/<KIND>/<ex-date>` is unique per action; the same entity, kind and ex-date
 * appearing twice in one payload is a data error (SCHEMA_DRIFT), never a silent overwrite. Values are validated
 * by `corporateActionFromValue` - the same parser the read path uses - so a negative dividend or a nonpositive
 * split ratio is rejected here rather than by a second, drifting validator.
 */
export function parseTiingoCorporateActions(bytes: Uint8Array, ctx: TiingoCorporateActionsParseContext): PointInTimeObservation<Record<string, unknown>>[] {
  const parsed = RowsSchema.safeParse(parseJsonBytes(bytes, TIINGO_CA_SOURCE_LABEL));
  if (!parsed.success) throw new SchemaDriftError(TIINGO_CA_SOURCE_LABEL, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const symbol = ctx.symbol.toUpperCase();
  const entityId = ctx.entityIds?.[symbol] ?? symbol;
  const seen = new Set<string>();
  const out: PointInTimeObservation<Record<string, unknown>>[] = [];
  for (const row of parsed.data) {
    const exDate = isoDate(row.date.slice(0, 10));
    const divCash = toDec(row.divCash, `${symbol} ${exDate} divCash`);
    const splitFactor = toDec(row.splitFactor, `${symbol} ${exDate} splitFactor`);
    // Corrupt feed values are a hard error, not a silent no-action: a negative divCash would slip past the
    // `> 0` test below, and a nonpositive splitFactor is never a real ratio.
    if (divCash.lt(0)) throw new SchemaDriftError(TIINGO_CA_SOURCE_LABEL, `${symbol} ${exDate}: divCash is negative (${divCash.toFixed()})`);
    if (!splitFactor.gt(0)) throw new SchemaDriftError(TIINGO_CA_SOURCE_LABEL, `${symbol} ${exDate}: splitFactor must be positive (${splitFactor.toFixed()})`);
    const rawActions: Record<string, unknown>[] = [];
    if (divCash.gt(0)) rawActions.push({ kind: "CASH_DIVIDEND", entityId, amount: divCash.toFixed(), exDate, payDate: exDate, qualified: false });
    if (!splitFactor.eq(1)) rawActions.push({ kind: "SPLIT", entityId, ratio: splitFactor.toFixed(), exDate });
    for (const raw of rawActions) {
      let action;
      try {
        action = corporateActionFromValue(raw);
      } catch (err) {
        throw new SchemaDriftError(TIINGO_CA_SOURCE_LABEL, `${symbol} ${exDate}: ${err instanceof Error ? err.message : "malformed action"}`);
      }
      const locator = `tiingo/corporate-actions/${entityId}/${action.kind}/${exDate}`;
      if (seen.has(locator)) throw new SchemaDriftError(TIINGO_CA_SOURCE_LABEL, `duplicate action ${locator} (same entity, kind and ex-date twice in one payload)`);
      seen.add(locator);
      out.push(
        corporateActionObservation(action, {
          sourceLocator: locator,
          availableAt: dateStartUtc(exDate),
          ingestedAt: ctx.ingestedAt,
          rawContentHash: ctx.rawContentHash,
          adapterVersion: ADAPTER_VERSION,
          parserVersion: PARSER_VERSION,
          qualityFlags: [UNVERIFIED_SINGLE_SOURCE],
        }),
      );
    }
  }
  return out;
}

/**
 * Fetch one Tiingo prices request per ticker (same endpoint as the bars adapter) and extract the corporate
 * actions. The raw payload is stored once, content-addressed, so a bar ingest and an action ingest of the same
 * request deduplicate to a single artifact.
 */
export async function fetchTiingoCorporateActions(client: AllowlistedHttpClient, store: ArtifactStore, ctx: TiingoContext): Promise<FetchOutcome<Record<string, unknown>>> {
  if (ctx.apiKey === undefined || ctx.apiKey.trim() === "") throw new MissingSourceCredentialError(TIINGO_CA_SOURCE_LABEL, "tiingoApiKey");
  const headers = { Authorization: `Token ${ctx.apiKey}`, "Content-Type": "application/json" };
  const secrets = [ctx.apiKey];
  const artifacts: ArtifactRef[] = [];
  const observations: PointInTimeObservation<Record<string, unknown>>[] = [];
  for (const symbol of normalizeSymbols(ctx.symbols)) {
    const url = tiingoRequestUrl(symbol, ctx.start, ctx.end);
    const { put, ref } = await fetchAndStore(client, store, url, { headers, secrets, locator: url, mime: "application/json", retention: "market" });
    artifacts.push(ref);
    const parseCtx: TiingoCorporateActionsParseContext = { calendar: ctx.calendar, ingestedAt: ctx.ingestedAt, rawContentHash: put.hash, symbol };
    if (ctx.entityIds !== undefined) parseCtx.entityIds = ctx.entityIds;
    observations.push(...parseTiingoCorporateActions(store.get(put.hash), parseCtx));
  }
  return { artifacts, observations };
}
