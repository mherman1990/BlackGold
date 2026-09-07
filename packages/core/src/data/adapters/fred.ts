import { isoDate, type IsoDate } from "@blackgold/shared";
import { z } from "zod";
import { MissingSourceCredentialError } from "../../errors.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { AllowlistedHttpClient } from "../http.ts";
import { fredReleaseEstimate } from "../lag-rules.ts";
import type { PointInTimeObservation } from "../pit/types.ts";
import {
  baseObservation,
  fetchAndStore,
  idForSeries,
  midnightUtc,
  optionalDecimalString,
  parseJsonBytes,
  SchemaDriftError,
  type AdapterContext,
  type ArtifactRef,
  type FetchOutcome,
  type ParseContext,
} from "./common.ts";

/**
 * FRED / ALFRED adapter (docs/DATA_PROVENANCE_SPEC.md section 3, "FRED and ALFRED").
 *
 * Historical research must use real-time vintages, so observations are fetched with a realtime window and
 * stored one row per vintage: effectiveAt = the observation period, vintageAt = realtime_start, availableAt
 * from `fredReleaseEstimate` (08:30 ET on the vintage date, AVAILABLE_AT_ESTIMATED). The current revision is
 * just another vintage. The API key is a query parameter: it is stripped from every locator, value, and
 * error message; the raw response body never contains it.
 */
export const ADAPTER_VERSION = "1.0.0";
export const PARSER_VERSION = "1.0.0";
const VERSIONS = { adapterVersion: ADAPTER_VERSION, parserVersion: PARSER_VERSION };

const BASE = "https://api.stlouisfed.org/fred";
/** The whole ALFRED history: FRED's own sentinel dates. */
export const FRED_REALTIME_MIN = isoDate("1776-07-04");
export const FRED_REALTIME_MAX = isoDate("9999-12-31");

export function fredSourceId(seriesId: string): string {
  return `fred.${idForSeries(seriesId)}`;
}

export type FredObservationValue = {
  seriesId: string;
  /** Observation period date as printed by FRED (YYYY-MM-DD). */
  date: IsoDate;
  /** Canonical decimal string, or null where FRED prints "." (missing). */
  value: string | null;
  realtimeStart: IsoDate;
  realtimeEnd: IsoDate;
};

export type FredContext = AdapterContext & {
  apiKey?: string | undefined;
  realtimeStart?: IsoDate | undefined;
  realtimeEnd?: IsoDate | undefined;
};

function requireKey(ctx: FredContext, seriesId: string): string {
  if (ctx.apiKey === undefined || ctx.apiKey.trim() === "") throw new MissingSourceCredentialError(fredSourceId(seriesId), "fredApiKey");
  return ctx.apiKey;
}

/** Locator form: the request URL relative to the API root with the key removed. */
export function observationsLocator(seriesId: string, realtimeStart: IsoDate, realtimeEnd: IsoDate): string {
  return `fred/series/observations?series_id=${idForSeries(seriesId)}&realtime_start=${realtimeStart}&realtime_end=${realtimeEnd}`;
}

export async function fetchSeriesVintages(
  client: AllowlistedHttpClient,
  store: ArtifactStore,
  seriesId: string,
  ctx: FredContext,
): Promise<FetchOutcome<FredObservationValue>> {
  const key = requireKey(ctx, seriesId);
  const realtimeStart = ctx.realtimeStart ?? FRED_REALTIME_MIN;
  const realtimeEnd = ctx.realtimeEnd ?? FRED_REALTIME_MAX;
  const url = new URL(`${BASE}/series/observations`);
  url.searchParams.set("series_id", idForSeries(seriesId));
  url.searchParams.set("api_key", key);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("realtime_start", realtimeStart);
  url.searchParams.set("realtime_end", realtimeEnd);
  const locator = observationsLocator(seriesId, realtimeStart, realtimeEnd);
  const { put, ref } = await fetchAndStore(client, store, url.toString(), { locator, mime: "application/json", retention: "macro", secrets: [key] });
  const observations = parseObservations(store.get(put.hash), { calendar: ctx.calendar, ingestedAt: ctx.ingestedAt, rawContentHash: put.hash, seriesId });
  return { artifacts: [ref], observations };
}

export async function fetchVintageDates(
  client: AllowlistedHttpClient,
  store: ArtifactStore,
  seriesId: string,
  ctx: FredContext,
): Promise<{ artifacts: ArtifactRef[]; vintageDates: IsoDate[] }> {
  const key = requireKey(ctx, seriesId);
  const url = new URL(`${BASE}/series/vintagedates`);
  url.searchParams.set("series_id", idForSeries(seriesId));
  url.searchParams.set("api_key", key);
  url.searchParams.set("file_type", "json");
  const locator = `fred/series/vintagedates?series_id=${idForSeries(seriesId)}`;
  const { put, ref } = await fetchAndStore(client, store, url.toString(), { locator, mime: "application/json", retention: "macro", secrets: [key] });
  return { artifacts: [ref], vintageDates: parseVintageDates(store.get(put.hash), seriesId) };
}

const ObservationsSchema = z.object({
  realtime_start: z.string(),
  realtime_end: z.string(),
  observations: z.array(z.object({ realtime_start: z.string(), realtime_end: z.string(), date: z.string(), value: z.string() })),
});

export type FredParseContext = ParseContext & { seriesId: string };

/** Pure: one `fred.<SERIES>` row per (period, vintage). Values stay strings; "." becomes null. */
export function parseObservations(bytes: Uint8Array, ctx: FredParseContext): PointInTimeObservation<FredObservationValue>[] {
  const sourceId = fredSourceId(ctx.seriesId);
  const parsed = ObservationsSchema.safeParse(parseJsonBytes(bytes, sourceId));
  if (!parsed.success) throw new SchemaDriftError(sourceId, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const doc = parsed.data;
  const seriesId = idForSeries(ctx.seriesId);
  const locator = observationsLocator(seriesId, isoDate(doc.realtime_start), isoDate(doc.realtime_end));
  return doc.observations.map((o) => {
    const date = isoDate(o.date);
    const realtimeStart = isoDate(o.realtime_start);
    const realtimeEnd = isoDate(o.realtime_end);
    const lag = fredReleaseEstimate(realtimeStart);
    const value: FredObservationValue = {
      seriesId,
      date,
      value: o.value.trim() === "." ? null : optionalDecimalString(o.value),
      realtimeStart,
      realtimeEnd,
    };
    return baseObservation(
      {
        sourceId,
        sourceLocator: locator,
        entityId: seriesId,
        effectiveAt: midnightUtc(date),
        vintageAt: midnightUtc(realtimeStart),
        availableAt: lag.availableAt,
        value,
        qualityFlags: lag.flags,
      },
      ctx,
      VERSIONS,
    );
  });
}

const VintageDatesSchema = z.object({ vintage_dates: z.array(z.string()) });

export function parseVintageDates(bytes: Uint8Array, seriesId: string): IsoDate[] {
  const sourceId = fredSourceId(seriesId);
  const parsed = VintageDatesSchema.safeParse(parseJsonBytes(bytes, sourceId));
  if (!parsed.success) throw new SchemaDriftError(sourceId, "vintage_dates missing");
  return parsed.data.vintage_dates.map(isoDate);
}
