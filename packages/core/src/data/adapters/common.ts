import { dec, utc, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../../calendar/types.ts";
import type { ArtifactStore, PutResult, RetentionClass } from "../artifacts/store.ts";
import type { AllowlistedHttpClient, HttpResponse } from "../http.ts";
import type { PointInTimeObservation } from "../pit/types.ts";

/**
 * Shared plumbing for the public-source adapters (docs/DATA_PROVENANCE_SPEC.md sections 1, 3, 7).
 *
 * Every adapter is split in two:
 *   - `fetch*`  takes the injected AllowlistedHttpClient and ArtifactStore, stores the raw response bytes,
 *               and hands the returned hash to the parser as `rawContentHash`.
 *   - `parse*`  is a pure function of (bytes, context, PARSER_VERSION) -> PointInTimeObservation[].
 * Release-lag arithmetic lives ONLY in ../lag-rules.ts; adapters call those functions and never reimplement them.
 */

/** Context every fetch needs: the calendar for lag rules and the ingestion instant recorded on each row. */
export type AdapterContext = { calendar: ExchangeCalendar; ingestedAt: UtcInstant };

/** Context every parser needs: the fetch context plus the hash of the artifact being parsed. */
export type ParseContext = AdapterContext & { rawContentHash: string };

export type ArtifactRef = { hash: string; locator: string; deduplicated: boolean; bytesRaw: number };

export type FetchOutcome<T> = { artifacts: ArtifactRef[]; observations: PointInTimeObservation<T>[] };

/** Raised when a raw payload does not match the adapter's schema (quality code SCHEMA_DRIFT). Nothing is written. */
export class SchemaDriftError extends Error {
  readonly sourceId: string;
  constructor(sourceId: string, detail: string) {
    super(`SCHEMA_DRIFT in ${sourceId}: ${detail}`);
    this.name = "SchemaDriftError";
    this.sourceId = sourceId;
  }
}

/** The fields a parser must supply; the remainder of the observation is filled from the context. */
export type ObservationInput<T> = {
  sourceId: string;
  sourceLocator: string;
  entityId?: string;
  observedAt?: UtcInstant;
  effectiveAt?: UtcInstant;
  availableAt: UtcInstant;
  vintageAt?: UtcInstant;
  value: T;
  qualityFlags: readonly string[];
};

/** Build a complete observation from parser output plus context and the adapter's version constants. */
export function baseObservation<T>(
  input: ObservationInput<T>,
  ctx: ParseContext,
  versions: { adapterVersion: string; parserVersion: string },
): PointInTimeObservation<T> {
  const obs: PointInTimeObservation<T> = {
    sourceId: input.sourceId,
    sourceLocator: input.sourceLocator,
    availableAt: input.availableAt,
    ingestedAt: ctx.ingestedAt,
    rawContentHash: ctx.rawContentHash,
    adapterVersion: versions.adapterVersion,
    parserVersion: versions.parserVersion,
    value: input.value,
    qualityFlags: [...new Set(input.qualityFlags)].sort(),
  };
  if (input.entityId !== undefined) obs.entityId = input.entityId;
  if (input.observedAt !== undefined) obs.observedAt = input.observedAt;
  if (input.effectiveAt !== undefined) obs.effectiveAt = input.effectiveAt;
  if (input.vintageAt !== undefined) obs.vintageAt = input.vintageAt;
  return obs;
}

/**
 * Canonical decimal string for a provider number or numeric string. Providers emit JSON numbers (Alpaca) or
 * strings (FRED, Socrata); both become the exact `Dec.toFixed()` form so no binary float reaches a ledger.
 * NaN, Infinity, empty strings, and non-numeric text are rejected.
 */
export function decimalString(x: string | number | bigint): string {
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new TypeError(`decimalString: non-finite number ${x}`);
    return dec(x.toString()).toFixed();
  }
  if (typeof x === "bigint") return dec(x).toFixed();
  const s = x.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) throw new TypeError(`decimalString: not a decimal: "${s}"`);
  return dec(s).toFixed();
}

/** Like decimalString but maps null/undefined/"" to null. */
export function optionalDecimalString(x: string | number | bigint | null | undefined): string | null {
  if (x === null || x === undefined || (typeof x === "string" && x.trim() === "")) return null;
  return decimalString(x);
}

/** 00:00:00Z on a calendar date, the encoding for date-only fields (report dates, periods, vintages). */
export function midnightUtc(date: IsoDate): UtcInstant {
  return utc(`${date}T00:00:00Z`);
}

/** Entity id for an SEC registrant: `cik:<10 digits>`. */
export function idForCik(cik: string | number): string {
  return `cik:${padCik(cik)}`;
}

export function padCik(cik: string | number): string {
  const digits = typeof cik === "number" ? cik.toString() : cik.trim().replace(/^cik:/i, "").replace(/^CIK/i, "");
  if (!/^\d{1,10}$/.test(digits)) throw new TypeError(`Not a CIK: ${typeof cik === "number" ? cik : cik.trim()}`);
  return digits.padStart(10, "0");
}

/** Accession number in canonical `0001234567-26-000123` form from either the dashed or the 18-digit form. */
export function canonicalAccession(raw: string): string {
  const s = raw.trim();
  if (/^\d{10}-\d{2}-\d{6}$/.test(s)) return s;
  if (/^\d{18}$/.test(s)) return `${s.slice(0, 10)}-${s.slice(10, 12)}-${s.slice(12)}`;
  throw new TypeError(`Not an accession number: ${s}`);
}

/** Entity id for a FRED series. */
export function idForSeries(seriesId: string): string {
  return seriesId.trim().toUpperCase();
}

/** Remove named query parameters (credentials) from a URL so it can be stored or logged. */
export function redactUrl(url: string, params: readonly string[]): string {
  const u = new URL(url);
  for (const p of params) if (u.searchParams.has(p)) u.searchParams.set(p, "REDACTED");
  return u.toString();
}

/** Scrub secret substrings from an error message; the error type is preserved where it has a plain constructor. */
export function scrubError(err: unknown, secrets: readonly string[]): Error {
  const scrub = (text: string): string => secrets.filter((s) => s.length > 0).reduce((acc, s) => acc.split(s).join("[REDACTED]"), text);
  if (err instanceof Error) {
    const copy = new Error(scrub(err.message));
    copy.name = err.name;
    return copy;
  }
  return new Error(scrub(typeof err === "string" ? err : "unknown error"));
}

/**
 * GET through the allowlisted client, then store the raw body. Any thrown error is scrubbed of the given
 * secrets before it propagates so a credential can never reach a log or a ledger through an error message.
 */
export async function fetchAndStore(
  client: AllowlistedHttpClient,
  store: ArtifactStore,
  url: string,
  opts: { headers?: Record<string, string>; secrets?: readonly string[]; locator: string; mime: string; retention: RetentionClass },
): Promise<{ response: HttpResponse; put: PutResult; ref: ArtifactRef }> {
  const secrets = opts.secrets ?? [];
  let response: HttpResponse;
  try {
    response = await client.get(url, opts.headers ? { headers: opts.headers } : {});
  } catch (err) {
    throw scrubError(err, secrets);
  }
  const putMeta: Parameters<ArtifactStore["put"]>[1] = { locator: opts.locator, mime: opts.mime, retention: opts.retention };
  if (response.etag !== null) putMeta.etag = response.etag;
  if (response.lastModified !== null) putMeta.lastModified = response.lastModified;
  const put = store.put(response.body, putMeta);
  return { response, put, ref: { hash: put.hash, locator: opts.locator, deduplicated: put.deduplicated, bytesRaw: put.bytesRaw } };
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Parse JSON bytes or raise SCHEMA_DRIFT; the caller validates the shape. */
export function parseJsonBytes(bytes: Uint8Array, sourceId: string): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (err) {
    throw new SchemaDriftError(sourceId, `payload is not JSON (${err instanceof Error ? err.message : "parse error"})`);
  }
}
