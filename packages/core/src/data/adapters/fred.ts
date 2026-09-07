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

/**
 * Vintage dates FRED will return in one `series/observations` response.
 *
 * Verified against the live API on 2026-09-07 (CR-28), not inferred: requesting the full ALFRED range for
 * `DGS10` is refused outright with
 *
 *     HTTP 400 - There are 5103 vintage dates in the specified real-time period: 1776-07-04 to 9999-12-31.
 *     This exceeds the maximum number of vintage dates allowed for this file type (2000).
 *
 * So a long-history daily series cannot be ingested in one request at all, and the previous single-request
 * implementation could not fetch one. Windowing is mandatory rather than an optimisation.
 */
export const FRED_MAX_VINTAGES_PER_REQUEST = 2000;

export type VintageWindow = {
  start: IsoDate;
  end: IsoDate;
  /**
   * True for every window after the first, meaning `start` is the previous window's `end`.
   *
   * Rows reporting `realtime_start === start` must be dropped from such a window: FRED clips a row's
   * `realtime_start` to the requested window, so a vintage that began earlier and is merely still current at
   * `start` is reported as if it began at `start`. Verified live (CR-29): the 2020-03-02 observation truly
   * begins 2020-03-03, but a window opening 2024-01-01 reports `realtime_start: 2024-01-01`.
   *
   * Dropping them loses nothing, because the window that shares this boundary as its `end` already returned
   * those rows with their true start.
   */
  sharesPreviousBoundary: boolean;
};

/**
 * Split sorted vintage dates into request windows of at most `max` vintages, sharing each boundary date.
 *
 * Boundaries are shared rather than adjacent so that no vintage is only ever seen clipped. Every vintage
 * start falls strictly inside, or at the end of, some window - and a start reported at a window's `end` is
 * never clipped, because the window contains it.
 *
 * Pure and exported so the arithmetic is tested without touching the network: the failure mode this replaces
 * (a fabricated vintage date) is silent and would corrupt point-in-time reads rather than error.
 */
export function vintageWindows(dates: readonly IsoDate[], max: number = FRED_MAX_VINTAGES_PER_REQUEST): VintageWindow[] {
  if (max < 2) throw new RangeError("a vintage window must hold at least 2 dates to share a boundary");
  const first = dates[0];
  if (first === undefined) return [];
  if (dates.length === 1) return [{ start: first, end: first, sharesPreviousBoundary: false }];
  const windows: VintageWindow[] = [];
  let i = 0;
  while (i < dates.length - 1) {
    const endIndex = Math.min(i + max - 1, dates.length - 1);
    const start = dates[i];
    const end = dates[endIndex];
    // Both indices are provably in range given the loop bound and the Math.min. Checked rather than
    // asserted so a future change to that arithmetic fails loudly here instead of emitting an undefined
    // boundary, which would silently widen a window past FRED's cap.
    if (start === undefined || end === undefined) throw new RangeError(`vintage window index out of range: ${i}..${endIndex} of ${dates.length}`);
    windows.push({ start, end, sharesPreviousBoundary: i > 0 });
    i = endIndex;
  }
  return windows;
}

async function fetchObservationWindow(
  client: AllowlistedHttpClient,
  store: ArtifactStore,
  seriesId: string,
  ctx: FredContext,
  key: string,
  realtimeStart: IsoDate,
  realtimeEnd: IsoDate,
): Promise<{ ref: ArtifactRef; observations: PointInTimeObservation<FredObservationValue>[] }> {
  const url = new URL(`${BASE}/series/observations`);
  url.searchParams.set("series_id", idForSeries(seriesId));
  url.searchParams.set("api_key", key);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("realtime_start", realtimeStart);
  url.searchParams.set("realtime_end", realtimeEnd);
  const locator = observationsLocator(seriesId, realtimeStart, realtimeEnd);
  const { put, ref } = await fetchAndStore(client, store, url.toString(), { locator, mime: "application/json", retention: "macro", secrets: [key] });
  const observations = parseObservations(store.get(put.hash), { calendar: ctx.calendar, ingestedAt: ctx.ingestedAt, rawContentHash: put.hash, seriesId });
  return { ref, observations };
}

/**
 * Fetch every vintage of a series, in as many windowed requests as FRED's 2000-vintage cap requires.
 *
 * Asks `series/vintagedates` first, because the window boundaries must be real vintage dates: a boundary that
 * is merely a calendar date would leave the clipping ambiguous, and the count that FRED enforces is a count
 * of vintages, not of days.
 */
export async function fetchSeriesVintages(
  client: AllowlistedHttpClient,
  store: ArtifactStore,
  seriesId: string,
  ctx: FredContext,
): Promise<FetchOutcome<FredObservationValue>> {
  const key = requireKey(ctx, seriesId);
  const realtimeStart = ctx.realtimeStart ?? FRED_REALTIME_MIN;
  const realtimeEnd = ctx.realtimeEnd ?? FRED_REALTIME_MAX;

  const vintages = await fetchVintageDates(client, store, seriesId, ctx);
  const windows = vintageWindows(vintages.vintageDates);

  // A series with no listed vintages still has current observations (FRED lists vintage dates only from the
  // point ALFRED began tracking a series). Fall back to the requested window as a single request.
  if (windows.length === 0) {
    const single = await fetchObservationWindow(client, store, seriesId, ctx, key, realtimeStart, realtimeEnd);
    return { artifacts: [...vintages.artifacts, single.ref], observations: single.observations };
  }

  const artifacts: ArtifactRef[] = [...vintages.artifacts];
  const observations: PointInTimeObservation<FredObservationValue>[] = [];
  for (const w of windows) {
    const got = await fetchObservationWindow(client, store, seriesId, ctx, key, w.start, w.end);
    artifacts.push(got.ref);
    for (const obs of got.observations) {
      // Drop the clipped carry-ins described on VintageWindow.sharesPreviousBoundary. Without this the store
      // gains a second row for the same period whose vintageAt is later than the truth - a fabricated vintage.
      if (w.sharesPreviousBoundary && obs.value.realtimeStart === w.start) continue;
      observations.push(obs);
    }
  }
  return { artifacts, observations };
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
  // Bound the listing to the caller's realtime window so a narrowed ingest does not window over vintages it
  // will not request, and so the locator distinguishes the two.
  const realtimeStart = ctx.realtimeStart ?? FRED_REALTIME_MIN;
  const realtimeEnd = ctx.realtimeEnd ?? FRED_REALTIME_MAX;
  url.searchParams.set("realtime_start", realtimeStart);
  url.searchParams.set("realtime_end", realtimeEnd);
  const locator = `fred/series/vintagedates?series_id=${idForSeries(seriesId)}&realtime_start=${realtimeStart}&realtime_end=${realtimeEnd}`;
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
