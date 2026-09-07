import { parseArgs } from "node:util";
import { isoDate, nowUtc, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { AppConfig } from "../config/schema.ts";
import { ArtifactStore } from "../data/artifacts/store.ts";
import { AllowlistedHttpClient, PUBLIC_SOURCE_HOSTS, PUBLIC_SOURCE_RATES, type FetchLike } from "../data/http.ts";
import { PointInTimeRepository } from "../data/pit/repository.ts";
import type { FetchOutcome } from "../data/adapters/common.ts";
import { fetchDailyBars } from "../data/adapters/alpaca-bars.ts";
import { COT_DATASETS, fetchCot, type CotDataset } from "../data/adapters/cftc-cot.ts";
import { fetchSeriesVintages } from "../data/adapters/fred.ts";
import { fetchSubmissions } from "../data/adapters/sec-edgar.ts";
import { MissingSourceCredentialError } from "../errors.ts";
import { Ledger } from "../ledger/ledger.ts";
import { CORE_VERSION } from "../version.ts";

/**
 * Ingest wiring for the `blackgold-core ingest` CLI (Phase 1). One run = one public source request set:
 * store raw artifacts, append observations through PointInTimeRepository.appendMany, write a ledger event.
 * Credentials come from AppConfig.sources only and never enter a locator, value, report, or ledger payload.
 */

export type IngestRequest =
  | { source: "sec-submissions"; cik: string }
  | { source: "fred"; seriesId: string; realtimeStart?: IsoDate | undefined; realtimeEnd?: IsoDate | undefined }
  | { source: "cot"; dataset: CotDataset; marketCode?: string | undefined; from?: IsoDate | undefined; to?: IsoDate | undefined }
  | { source: "alpaca-bars"; symbols: string[]; start: IsoDate; end: IsoDate };

export type IngestSource = IngestRequest["source"];
export const INGEST_SOURCES: readonly IngestSource[] = ["sec-submissions", "fred", "cot", "alpaca-bars"];

export type IngestReport = {
  source: IngestSource;
  request: IngestRequest;
  artifacts: number;
  artifactsDeduplicated: number;
  observations: number;
  deduplicated: number;
  conflicts: number;
  requestCount: number;
  sourceIds: string[];
  ledgerSeq: number;
  ingestedAt: UtcInstant;
};

export type IngestDeps = {
  db: Db;
  config: AppConfig;
  calendar: ExchangeCalendar;
  clock?: (() => number) | undefined;
  /** Injected transport for tests; production uses the platform fetch inside AllowlistedHttpClient. */
  fetchImpl?: FetchLike | undefined;
};

export class ArtifactBudgetExceededError extends Error {
  constructor(usageBytes: number, budgetBytes: number) {
    super(`Artifact store holds ${usageBytes} bytes, over the configured budget of ${budgetBytes}; ingest refused`);
    this.name = "ArtifactBudgetExceededError";
  }
}

/** The public-source client: allowlist and rates from http.ts, User-Agent "BlackGold/<version> (<contact>)". */
export function buildPublicSourceClient(config: AppConfig, fetchImpl?: FetchLike): AllowlistedHttpClient {
  const contact = config.sources.secUserAgentContact;
  if (contact === undefined || contact.trim() === "") throw new MissingSourceCredentialError("ingest", "secUserAgentContact");
  const opts: ConstructorParameters<typeof AllowlistedHttpClient>[0] = {
    allowlist: PUBLIC_SOURCE_HOSTS,
    ratePerSecond: PUBLIC_SOURCE_RATES,
    userAgent: `BlackGold/${CORE_VERSION} (${contact})`,
  };
  if (fetchImpl !== undefined) opts.fetchImpl = fetchImpl;
  return new AllowlistedHttpClient(opts);
}

export async function runIngest(deps: IngestDeps, request: IngestRequest): Promise<IngestReport> {
  const clock = deps.clock ?? Date.now;
  const ingestedAt = nowUtc(clock);
  const ledger = new Ledger(deps.db, clock);
  const store = new ArtifactStore(deps.config.artifactsDir, deps.db, clock);
  const usage = store.diskUsageBytes();
  const budget = deps.config.sources.artifactBudgetBytes;
  if (usage > budget) {
    ledger.append("ingest.refused_budget", { source: request.source, usageBytes: usage, budgetBytes: budget }, ingestedAt);
    throw new ArtifactBudgetExceededError(usage, budget);
  }
  const client = buildPublicSourceClient(deps.config, deps.fetchImpl);
  const ctx = { calendar: deps.calendar, ingestedAt };
  const outcome: FetchOutcome<unknown> = await dispatch(client, store, deps.config, ctx, request);

  const repo = new PointInTimeRepository(deps.db, { clock });
  const results = repo.appendMany(outcome.observations);
  const sourceIds = [...new Set(outcome.observations.map((o) => o.sourceId))].sort();
  const report = {
    source: request.source,
    request,
    artifacts: outcome.artifacts.length,
    artifactsDeduplicated: outcome.artifacts.filter((a) => a.deduplicated).length,
    observations: results.length,
    deduplicated: results.filter((r) => r.deduplicated).length,
    conflicts: results.filter((r) => r.conflict).length,
    requestCount: client.requests(),
    sourceIds,
  };
  const event = ledger.append("ingest.completed", report, ingestedAt);
  return { ...report, ledgerSeq: event.seq, ingestedAt };
}

async function dispatch(
  client: AllowlistedHttpClient,
  store: ArtifactStore,
  config: AppConfig,
  ctx: { calendar: ExchangeCalendar; ingestedAt: UtcInstant },
  request: IngestRequest,
): Promise<FetchOutcome<unknown>> {
  const s = config.sources;
  switch (request.source) {
    case "sec-submissions":
      return fetchSubmissions(client, store, request.cik, { ...ctx, userAgentContact: s.secUserAgentContact });
    case "fred":
      return fetchSeriesVintages(client, store, request.seriesId, { ...ctx, apiKey: s.fredApiKey, realtimeStart: request.realtimeStart, realtimeEnd: request.realtimeEnd });
    case "cot":
      return fetchCot(client, store, { ...ctx, dataset: request.dataset, marketCode: request.marketCode, from: request.from, to: request.to });
    case "alpaca-bars":
      return fetchDailyBars(client, store, { ...ctx, keyId: s.alpacaKeyId, secretKey: s.alpacaSecretKey, symbols: request.symbols, start: request.start, end: request.end });
  }
}

// ---------------------------------------------------------------------------------------------
// CLI argument parsing (node:util parseArgs). Kept here so main.ts stays a thin dispatcher.
// ---------------------------------------------------------------------------------------------

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type OptionSpec = Record<string, { type: "string" | "boolean"; short?: string }>;
export type ParsedOptions = Partial<Record<string, string | boolean>>;

/** Strict option parsing: unknown flags and positionals are usage errors. */
export function parseOptions(args: readonly string[], spec: OptionSpec): ParsedOptions {
  try {
    const { values, positionals } = parseArgs({ args: [...args], options: spec, strict: true, allowPositionals: true });
    if (positionals.length > 0) throw new UsageError(`Unexpected argument: ${positionals.join(" ")}`);
    const out: ParsedOptions = {};
    for (const key of Object.keys(spec)) {
      const v: unknown = (values as Record<string, unknown>)[key];
      if (typeof v === "string" || typeof v === "boolean") out[key] = v;
    }
    return out;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(err instanceof Error ? err.message : "invalid arguments");
  }
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function date(v: string | boolean | undefined, name: string): IsoDate | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  try {
    return isoDate(s);
  } catch {
    throw new UsageError(`--${name} must be YYYY-MM-DD`);
  }
}

function required(v: string | undefined, name: string): string {
  if (v === undefined) throw new UsageError(`--${name} is required`);
  return v;
}

export const INGEST_USAGE = `ingest sec-submissions --cik <cik>
ingest fred --series <SERIES_ID> [--realtime-start YYYY-MM-DD] [--realtime-end YYYY-MM-DD]
ingest cot --dataset <${COT_DATASETS.join("|")}> [--market <code>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
ingest alpaca-bars --symbols A,B,C --start YYYY-MM-DD --end YYYY-MM-DD`;

export function parseIngestArgs(args: readonly string[]): IngestRequest {
  const [source, ...rest] = args;
  if (source === undefined) throw new UsageError(`ingest requires a source\n${INGEST_USAGE}`);
  switch (source) {
    case "sec-submissions": {
      const o = parseOptions(rest, { cik: { type: "string" } });
      return { source, cik: required(str(o["cik"]), "cik") };
    }
    case "fred": {
      const o = parseOptions(rest, { series: { type: "string" }, "realtime-start": { type: "string" }, "realtime-end": { type: "string" } });
      return { source, seriesId: required(str(o["series"]), "series"), realtimeStart: date(o["realtime-start"], "realtime-start"), realtimeEnd: date(o["realtime-end"], "realtime-end") };
    }
    case "cot": {
      const o = parseOptions(rest, { dataset: { type: "string" }, market: { type: "string" }, from: { type: "string" }, to: { type: "string" } });
      const dataset = required(str(o["dataset"]), "dataset");
      if (!isCotDataset(dataset)) throw new UsageError(`--dataset must be one of ${COT_DATASETS.join(", ")}`);
      return { source, dataset, marketCode: str(o["market"]), from: date(o["from"], "from"), to: date(o["to"], "to") };
    }
    case "alpaca-bars": {
      const o = parseOptions(rest, { symbols: { type: "string" }, start: { type: "string" }, end: { type: "string" } });
      const symbols = required(str(o["symbols"]), "symbols").split(",").map((x) => x.trim()).filter((x) => x.length > 0);
      const start = date(o["start"], "start");
      const end = date(o["end"], "end");
      if (start === undefined || end === undefined) throw new UsageError("--start and --end are required");
      return { source, symbols, start, end };
    }
    default:
      throw new UsageError(`Unknown ingest source: ${source}\n${INGEST_USAGE}`);
  }
}

function isCotDataset(s: string): s is CotDataset {
  return (COT_DATASETS as readonly string[]).includes(s);
}
