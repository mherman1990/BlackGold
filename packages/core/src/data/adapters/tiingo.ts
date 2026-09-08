import { isoDate, utc, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { z } from "zod";
import { MissingSourceCredentialError } from "../../errors.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { AllowlistedHttpClient } from "../http.ts";
import { dailyBarTimes } from "../lag-rules.ts";
import type { PointInTimeObservation } from "../pit/types.ts";
import {
  baseObservation,
  decimalString,
  fetchAndStore,
  parseJsonBytes,
  SchemaDriftError,
  type AdapterContext,
  type ArtifactRef,
  type FetchOutcome,
  type ParseContext,
} from "./common.ts";

/**
 * Tiingo end-of-day daily bars (docs/DATA_PROVENANCE_SPEC.md section 3, "Market data"). A capability probe
 * for deeper history than Alpaca's free IEX feed serves: Alpaca returns bars only from ~2019, which leaves the
 * charter's 2007-2018 design window empty, and Tiingo's daily endpoint reaches each ticker's inception.
 *
 * This adapter reads the RAW (unadjusted) open/high/low/close/volume, labelled source `tiingo.eod.bars.1d` and
 * venue "tiingo"; Black Gold recomputes total return from raw bars plus the corporate-action ledger, so the
 * provider's adjusted columns and its `divCash`/`splitFactor` are deliberately NOT consumed here - the latter
 * are the natural input to a follow-up corporate-action adapter, kept separate so a bar ingest and a
 * corporate-action ingest never entangle. observedAt is the exchange-calendar close and availableAt is the
 * conservative close + 60 minutes (AVAILABLE_AT_ESTIMATED), identical to the Alpaca adapter. The API token
 * travels only in a request header; it never reaches a locator, value, or error message.
 *
 * Adopting Tiingo as the charter's bar source is a data-source change and therefore a new strategy version
 * (CLAUDE.md versioning rule); this adapter only makes the capability measurable under its own source id.
 */
export const ADAPTER_VERSION = "1.0.0";
export const PARSER_VERSION = "1.0.0";
const VERSIONS = { adapterVersion: ADAPTER_VERSION, parserVersion: PARSER_VERSION };

export const TIINGO_BARS_SOURCE_ID = "tiingo.eod.bars.1d";
const BASE = "https://api.tiingo.com/tiingo/daily";

/** The stored value shape matches `rawBarFromValue` (market/types.ts): {symbol, session, o/h/l/c, volume, venue}. */
export type TiingoBar = {
  symbol: string;
  session: IsoDate;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Integer share volume as a decimal string. */
  volume: string;
  venue: "tiingo";
  /** Provider row timestamp as received (the session date at 00:00Z). */
  providerTimestamp: UtcInstant;
};

export type TiingoContext = AdapterContext & {
  apiKey?: string | undefined;
  symbols: readonly string[];
  start: IsoDate;
  end: IsoDate;
  /** Optional symbol -> stable entity id mapping. Default: the symbol. */
  entityIds?: Readonly<Record<string, string>> | undefined;
};

function normalizeSymbols(symbols: readonly string[]): string[] {
  const out = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0))].sort();
  for (const s of out) if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) throw new TypeError(`Unsafe symbol: ${s}`);
  if (out.length === 0) throw new RangeError("at least one symbol is required");
  return out;
}

/** One ticker per request; Tiingo returns the whole date range in a single JSON array, no pagination. */
export function tiingoRequestUrl(ticker: string, start: IsoDate, end: IsoDate): string {
  const url = new URL(`${BASE}/${ticker.toLowerCase()}/prices`);
  url.searchParams.set("startDate", start);
  url.searchParams.set("endDate", end);
  url.searchParams.set("resampleFreq", "daily");
  url.searchParams.set("format", "json");
  return url.toString();
}

export async function fetchTiingoDaily(client: AllowlistedHttpClient, store: ArtifactStore, ctx: TiingoContext): Promise<FetchOutcome<TiingoBar>> {
  if (ctx.apiKey === undefined || ctx.apiKey.trim() === "") throw new MissingSourceCredentialError(TIINGO_BARS_SOURCE_ID, "tiingoApiKey");
  const headers = { Authorization: `Token ${ctx.apiKey}`, "Content-Type": "application/json" };
  const secrets = [ctx.apiKey];
  const artifacts: ArtifactRef[] = [];
  const observations: PointInTimeObservation<TiingoBar>[] = [];
  for (const symbol of normalizeSymbols(ctx.symbols)) {
    const url = tiingoRequestUrl(symbol, ctx.start, ctx.end);
    const { put, ref } = await fetchAndStore(client, store, url, { headers, secrets, locator: url, mime: "application/json", retention: "market" });
    artifacts.push(ref);
    observations.push(...parseTiingoDaily(store.get(put.hash), { calendar: ctx.calendar, ingestedAt: ctx.ingestedAt, rawContentHash: put.hash, symbol, entityIds: ctx.entityIds }));
  }
  return { artifacts, observations };
}

const RowSchema = z
  .object({
    date: z.string(),
    open: z.union([z.number(), z.string()]),
    high: z.union([z.number(), z.string()]),
    low: z.union([z.number(), z.string()]),
    close: z.union([z.number(), z.string()]),
    volume: z.union([z.number(), z.string()]),
  })
  // Tolerate (and ignore) the adjusted columns, divCash, and splitFactor - a corporate-action adapter, not this one, consumes those.
  .catchall(z.unknown());
const RowsSchema = z.array(RowSchema);

export type TiingoParseContext = ParseContext & { symbol: string; entityIds?: Readonly<Record<string, string>> | undefined };

/**
 * Pure: one `tiingo.eod.bars.1d` row per bar. Locator `tiingo/eod/1d/<SYMBOL>/<session>`. Tiingo's `date` is a
 * session date at 00:00Z, so the session is the date part taken directly (no timezone shift). A bar on a
 * non-session or a repeated date is STALE_BAR (spec section 5 / 11).
 */
export function parseTiingoDaily(bytes: Uint8Array, ctx: TiingoParseContext): PointInTimeObservation<TiingoBar>[] {
  const parsed = RowsSchema.safeParse(parseJsonBytes(bytes, TIINGO_BARS_SOURCE_ID));
  if (!parsed.success) throw new SchemaDriftError(TIINGO_BARS_SOURCE_ID, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const symbol = ctx.symbol.toUpperCase();
  const entityId = ctx.entityIds?.[symbol] ?? symbol;
  const out: PointInTimeObservation<TiingoBar>[] = [];
  let previousSession: IsoDate | undefined;
  let repeatCount = 0;
  for (const row of parsed.data) {
    const providerTimestamp = utc(row.date);
    const session = isoDate(row.date.slice(0, 10));
    const flags: string[] = [];
    let observedAt: UtcInstant;
    let availableAt: UtcInstant;
    let locator = `tiingo/eod/1d/${symbol}/${session}`;
    if (ctx.calendar.isSession(session)) {
      const times = dailyBarTimes(session, ctx.calendar);
      observedAt = times.observedAt;
      availableAt = times.availableAt;
      flags.push(...times.flags);
    } else {
      const next = dailyBarTimes(ctx.calendar.nextSession(providerTimestamp), ctx.calendar);
      observedAt = providerTimestamp;
      availableAt = next.availableAt;
      flags.push("STALE_BAR", ...next.flags);
    }
    if (previousSession !== undefined && session === previousSession) {
      repeatCount++;
      flags.push("STALE_BAR");
      locator = `${locator}#repeat${repeatCount}`;
    } else {
      repeatCount = 0;
    }
    previousSession = session;
    const value: TiingoBar = {
      symbol,
      session,
      open: decimalString(row.open),
      high: decimalString(row.high),
      low: decimalString(row.low),
      close: decimalString(row.close),
      volume: decimalString(row.volume),
      venue: "tiingo",
      providerTimestamp,
    };
    out.push(baseObservation({ sourceId: TIINGO_BARS_SOURCE_ID, sourceLocator: locator, entityId, observedAt, availableAt, value, qualityFlags: flags }, ctx, VERSIONS));
  }
  return out;
}
