import { dateOfInstantInZone, utc, type IsoDate, type UtcInstant } from "@blackgold/shared";
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
  optionalDecimalString,
  parseJsonBytes,
  SchemaDriftError,
  type AdapterContext,
  type ArtifactRef,
  type FetchOutcome,
  type ParseContext,
} from "./common.ts";

/**
 * Alpaca market-data adapter, IEX feed, daily bars (docs/DATA_PROVENANCE_SPEC.md section 3, "Market data").
 * Host data.alpaca.markets is read-only market data on the public allowlist; the trading hosts are not and
 * never appear here. Bars are labelled venue "iex" and must never be presented as NBBO/consolidated.
 * observedAt is the session close from the exchange calendar (early closes honoured) and availableAt is the
 * conservative close + 60 minutes with AVAILABLE_AT_ESTIMATED, from `dailyBarTimes`.
 * Credentials travel only in request headers; they never reach a locator, value, or error message.
 */
export const ADAPTER_VERSION = "1.0.0";
export const PARSER_VERSION = "1.0.0";
const VERSIONS = { adapterVersion: ADAPTER_VERSION, parserVersion: PARSER_VERSION };

export const ALPACA_BARS_SOURCE_ID = "alpaca.iex.bars.1d";
const BASE = "https://data.alpaca.markets/v2/stocks/bars";
const NY = "America/New_York";
const PAGE_LIMIT = 10_000;
const MAX_PAGES = 1_000;

export type RawBar = {
  symbol: string;
  session: IsoDate;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Integer share volume as a decimal string. */
  volume: string;
  tradeCount: number | null;
  vwap: string | null;
  venue: "iex";
  /** Provider bar timestamp as received. */
  providerTimestamp: UtcInstant;
};

export type AlpacaBarsContext = AdapterContext & {
  keyId?: string | undefined;
  secretKey?: string | undefined;
  symbols: readonly string[];
  start: IsoDate;
  end: IsoDate;
  /** Optional symbol -> stable entity id mapping (docs/DATA_PROVENANCE_SPEC.md section 6a). Default: the symbol. */
  entityIds?: Readonly<Record<string, string>> | undefined;
};

function normalizeSymbols(symbols: readonly string[]): string[] {
  const out = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0))].sort();
  for (const s of out) if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) throw new TypeError(`Unsafe symbol: ${s}`);
  if (out.length === 0) throw new RangeError("at least one symbol is required");
  return out;
}

export function barsRequestUrl(ctx: Pick<AlpacaBarsContext, "symbols" | "start" | "end">, pageToken?: string): string {
  const url = new URL(BASE);
  url.searchParams.set("symbols", normalizeSymbols(ctx.symbols).join(","));
  url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("start", ctx.start);
  url.searchParams.set("end", ctx.end);
  url.searchParams.set("adjustment", "raw");
  url.searchParams.set("feed", "iex");
  url.searchParams.set("limit", PAGE_LIMIT.toString());
  url.searchParams.set("sort", "asc");
  if (pageToken !== undefined) url.searchParams.set("page_token", pageToken);
  return url.toString();
}

/** Fetch every page; each page is its own artifact and the parser runs per page. */
export async function fetchDailyBars(client: AllowlistedHttpClient, store: ArtifactStore, ctx: AlpacaBarsContext): Promise<FetchOutcome<RawBar>> {
  if (ctx.keyId === undefined || ctx.keyId.trim() === "") throw new MissingSourceCredentialError(ALPACA_BARS_SOURCE_ID, "alpacaKeyId");
  if (ctx.secretKey === undefined || ctx.secretKey.trim() === "") throw new MissingSourceCredentialError(ALPACA_BARS_SOURCE_ID, "alpacaSecretKey");
  const headers = { "APCA-API-KEY-ID": ctx.keyId, "APCA-API-SECRET-KEY": ctx.secretKey };
  const secrets = [ctx.keyId, ctx.secretKey];
  const artifacts: ArtifactRef[] = [];
  const observations: PointInTimeObservation<RawBar>[] = [];
  let pageToken: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = barsRequestUrl(ctx, pageToken);
    const { put, ref } = await fetchAndStore(client, store, url, { headers, secrets, locator: url, mime: "application/json", retention: "market" });
    artifacts.push(ref);
    const parsed = parseBarsPage(store.get(put.hash), { calendar: ctx.calendar, ingestedAt: ctx.ingestedAt, rawContentHash: put.hash, entityIds: ctx.entityIds });
    observations.push(...parsed.observations);
    if (parsed.nextPageToken === null) return { artifacts, observations };
    if (seen.has(parsed.nextPageToken)) throw new SchemaDriftError(ALPACA_BARS_SOURCE_ID, "pagination loop: repeated next_page_token");
    seen.add(parsed.nextPageToken);
    pageToken = parsed.nextPageToken;
  }
  throw new SchemaDriftError(ALPACA_BARS_SOURCE_ID, `more than ${MAX_PAGES} pages`);
}

const BarSchema = z.object({
  t: z.string(),
  o: z.union([z.number(), z.string()]),
  h: z.union([z.number(), z.string()]),
  l: z.union([z.number(), z.string()]),
  c: z.union([z.number(), z.string()]),
  v: z.union([z.number(), z.string()]),
  n: z.number().int().optional(),
  vw: z.union([z.number(), z.string()]).nullable().optional(),
});
const PageSchema = z.object({
  bars: z.record(z.string(), z.array(BarSchema).nullable()),
  next_page_token: z.string().nullable().optional(),
});

export type AlpacaParseContext = ParseContext & { entityIds?: Readonly<Record<string, string>> | undefined };

export function parseBars(bytes: Uint8Array, ctx: AlpacaParseContext): PointInTimeObservation<RawBar>[] {
  return parseBarsPage(bytes, ctx).observations;
}

/**
 * Pure: one `alpaca.iex.bars.1d` row per bar. Locator `alpaca/bars/1d/<SYMBOL>/<session>`.
 * A bar dated on a non-session, or repeating the previous bar's date, is STALE_BAR (spec section 5 / 11).
 */
export function parseBarsPage(bytes: Uint8Array, ctx: AlpacaParseContext): { observations: PointInTimeObservation<RawBar>[]; nextPageToken: string | null } {
  const parsed = PageSchema.safeParse(parseJsonBytes(bytes, ALPACA_BARS_SOURCE_ID));
  if (!parsed.success) throw new SchemaDriftError(ALPACA_BARS_SOURCE_ID, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const out: PointInTimeObservation<RawBar>[] = [];
  for (const symbolKey of Object.keys(parsed.data.bars).sort()) {
    const bars = parsed.data.bars[symbolKey] ?? [];
    const symbol = symbolKey.toUpperCase();
    const entityId = ctx.entityIds?.[symbol] ?? symbol;
    let previousSession: IsoDate | undefined;
    let repeatCount = 0;
    for (const bar of bars) {
      const providerTimestamp = utc(bar.t);
      const session = dateOfInstantInZone(providerTimestamp, NY);
      const flags: string[] = [];
      let observedAt: UtcInstant;
      let availableAt: UtcInstant;
      let locator = `alpaca/bars/1d/${symbol}/${session}`;
      if (ctx.calendar.isSession(session)) {
        const times = dailyBarTimes(session, ctx.calendar);
        observedAt = times.observedAt;
        availableAt = times.availableAt;
        flags.push(...times.flags);
      } else {
        // Not a trading day: the provider printed a bar that cannot be a session bar. Keep it, flagged, with the
        // bar's own timestamp as observedAt and the next session's publication as a conservative availability.
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
      const value: RawBar = {
        symbol,
        session,
        open: decimalString(bar.o),
        high: decimalString(bar.h),
        low: decimalString(bar.l),
        close: decimalString(bar.c),
        volume: decimalString(bar.v),
        tradeCount: bar.n ?? null,
        vwap: optionalDecimalString(bar.vw),
        venue: "iex",
        providerTimestamp,
      };
      out.push(baseObservation({ sourceId: ALPACA_BARS_SOURCE_ID, sourceLocator: locator, entityId, observedAt, availableAt, value, qualityFlags: flags }, ctx, VERSIONS));
    }
  }
  return { observations: out, nextPageToken: parsed.data.next_page_token ?? null };
}
