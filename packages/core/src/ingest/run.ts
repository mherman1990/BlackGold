import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isoDate, nowUtc, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import { processingDelayOverridesMs, type AppConfig } from "../config/schema.ts";
import { ArtifactBudgetExceededError, ArtifactStore } from "../data/artifacts/store.ts";
import { AllowlistedHttpClient, PUBLIC_SOURCE_HOSTS, PUBLIC_SOURCE_RATES, type FetchLike } from "../data/http.ts";
import { PointInTimeRepository } from "../data/pit/repository.ts";
import type { FetchOutcome } from "../data/adapters/common.ts";
import { fetchDailyBars } from "../data/adapters/alpaca-bars.ts";
import { fetchTiingoDaily } from "../data/adapters/tiingo.ts";
import { COT_DATASETS, fetchCot, type CotDataset } from "../data/adapters/cftc-cot.ts";
import { fetchSeriesVintages } from "../data/adapters/fred.ts";
import { fetchSubmissions } from "../data/adapters/sec-edgar.ts";
import { ingestCorporateActions } from "../data/adapters/corporate-actions.ts";
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
  | { source: "alpaca-bars"; symbols: string[]; start: IsoDate; end: IsoDate }
  | { source: "tiingo-bars"; symbols: string[]; start: IsoDate; end: IsoDate }
  | { source: "corporate-actions"; file: string; dataset?: string | undefined };

export type IngestSource = IngestRequest["source"];
export const INGEST_SOURCES: readonly IngestSource[] = ["sec-submissions", "fred", "cot", "alpaca-bars", "tiingo-bars", "corporate-actions"];

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
  // One instant for every observation this run produces, so a multi-page fetch cannot stamp two pages with
  // different `ingestedAt` values and make point-in-time reads of the same run incoherent. That is why it is
  // captured up front - but it is NOT what the ledger events below are stamped with: a ledger event records
  // when the thing happened, and by the time an ingest completes this value can be hours stale. Stamping an
  // event with it both misreports the audit record and risks landing on an already-sealed day
  // (`SealedDateAppendError`). The run's start stays in the payload.
  const ingestedAt = nowUtc(clock);
  const ledger = new Ledger(deps.db, clock);
  const budget = deps.config.sources.artifactBudgetBytes;
  // The store enforces the cap on every write, so a multi-page fetch cannot overrun it page by page.
  const store = new ArtifactStore(deps.config.artifactsDir, deps.db, clock, { budgetBytes: budget });
  // The HTTP client is built lazily: the file-based `corporate-actions` source needs no network and no SEC
  // User-Agent contact, so it must not be forced to construct (and validate) an egress client just to read a
  // local file. HTTP sources call getClient(); the vendoring source never does.
  let client: AllowlistedHttpClient | undefined;
  const getClient = (): AllowlistedHttpClient => (client ??= buildPublicSourceClient(deps.config, deps.fetchImpl));
  const ctx = { calendar: deps.calendar, ingestedAt };
  let outcome: FetchOutcome<unknown>;
  try {
    store.assertWithinBudget();
    outcome = await dispatch(getClient, store, deps.config, ctx, request);
  } catch (err) {
    if (err instanceof ArtifactBudgetExceededError) {
      ledger.append(
        "ingest.refused_budget",
        { source: request.source, startedAt: ingestedAt, usageBytes: err.usageBytes, budgetBytes: err.budgetBytes, attemptedBytes: err.attemptedBytes, requestsCompleted: client?.requests() ?? 0 },
        nowUtc(clock),
      );
    }
    throw err;
  }

  const repo = new PointInTimeRepository(deps.db, { clock, processingDelayOverrides: processingDelayOverridesMs(deps.config.sources) });
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
    requestCount: client?.requests() ?? 0,
    sourceIds,
  };
  const event = ledger.append("ingest.completed", { ...report, startedAt: ingestedAt }, nowUtc(clock));
  return { ...report, ledgerSeq: event.seq, ingestedAt };
}

async function dispatch(
  getClient: () => AllowlistedHttpClient,
  store: ArtifactStore,
  config: AppConfig,
  ctx: { calendar: ExchangeCalendar; ingestedAt: UtcInstant },
  request: IngestRequest,
): Promise<FetchOutcome<unknown>> {
  const s = config.sources;
  switch (request.source) {
    case "sec-submissions":
      return fetchSubmissions(getClient(), store, request.cik, { ...ctx, userAgentContact: s.secUserAgentContact });
    case "fred":
      return fetchSeriesVintages(getClient(), store, request.seriesId, { ...ctx, apiKey: s.fredApiKey, realtimeStart: request.realtimeStart, realtimeEnd: request.realtimeEnd });
    case "cot":
      return fetchCot(getClient(), store, { ...ctx, dataset: request.dataset, marketCode: request.marketCode, from: request.from, to: request.to });
    case "alpaca-bars":
      return fetchDailyBars(getClient(), store, { ...ctx, keyId: s.alpacaKeyId, secretKey: s.alpacaSecretKey, symbols: request.symbols, start: request.start, end: request.end });
    case "tiingo-bars":
      return fetchTiingoDaily(getClient(), store, { ...ctx, apiKey: s.tiingoApiKey, symbols: request.symbols, start: request.start, end: request.end });
    case "corporate-actions": {
      // Vendored actions (D-29): a local file, no network. Read the bytes here at the CLI boundary; the adapter
      // stores them as an artifact and parses into observations.
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(request.file));
      } catch (err) {
        throw new Error(`cannot read corporate-actions file ${request.file}: ${err instanceof Error ? err.message : "read error"}`);
      }
      return ingestCorporateActions(store, bytes, { ...ctx, ...(request.dataset !== undefined ? { dataset: request.dataset } : {}) });
    }
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
ingest alpaca-bars --symbols A,B,C --start YYYY-MM-DD --end YYYY-MM-DD
ingest tiingo-bars --symbols A,B,C --start YYYY-MM-DD --end YYYY-MM-DD
ingest corporate-actions --file <path.json> [--dataset <name>]`;

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
    case "tiingo-bars": {
      const o = parseOptions(rest, { symbols: { type: "string" }, start: { type: "string" }, end: { type: "string" } });
      const symbols = required(str(o["symbols"]), "symbols").split(",").map((x) => x.trim()).filter((x) => x.length > 0);
      const start = date(o["start"], "start");
      const end = date(o["end"], "end");
      if (start === undefined || end === undefined) throw new UsageError("--start and --end are required");
      return { source, symbols, start, end };
    }
    case "corporate-actions": {
      const o = parseOptions(rest, { file: { type: "string" }, dataset: { type: "string" } });
      return { source, file: required(str(o["file"]), "file"), dataset: str(o["dataset"]) };
    }
    default:
      throw new UsageError(`Unknown ingest source: ${source}\n${INGEST_USAGE}`);
  }
}

function isCotDataset(s: string): s is CotDataset {
  return (COT_DATASETS as readonly string[]).includes(s);
}
