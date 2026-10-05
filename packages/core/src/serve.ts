import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { nowUtc, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { processingDelayOverridesMs, type AppConfig } from "./config/schema.ts";
import type { ExchangeCalendar } from "./calendar/types.ts";
import { Ledger, sealThroughDate } from "./ledger/ledger.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { PointInTimeRepository } from "./data/pit/repository.ts";
import { DEFAULT_BARS_SOURCE_ID } from "./market/series.ts";
import { parseIngestArgs, runIngest } from "./ingest/run.ts";
import { charterUniverseMembers, loadCharterFile } from "./strategy/charter.ts";
import { registerShadowDecisionJob } from "./decision/shadow-job.ts";
import { runHealth, type HealthReport } from "./health/health.ts";
import { runFullVerification } from "./health/integrity.ts";
import { buildStatusReport } from "./status/model.ts";
import { renderStatusPage } from "./status/render.ts";
import { CORE_VERSION } from "./version.ts";

/**
 * Long-running core process for the Umbrel container.
 *
 * - A LOCAL, read-only HTTP status listener: GET / is an HTML status page, GET /health is the same health
 *   report as JSON, GET /status.txt is the plain-text view for terminals. It binds to
 *   all container interfaces because Umbrel's app_proxy is the only route to it; it never makes outbound
 *   requests and accepts no state-changing method.
 * - A scheduler loop that ticks every `schedulerPollSeconds`, running missed-run detection before due runs.
 *
 * Phase 0 registers two jobs: the daily heartbeat and the daily ledger seal. Nothing here touches a
 * broker or a model provider.
 */
export type ServeOptions = {
  config: AppConfig;
  db: Db;
  calendar: ExchangeCalendar;
  clock?: () => UtcInstant;
  /** Injected for tests; defaults to the process signals. */
  shutdownSignal?: AbortSignal;
  log?: (line: string) => void;
};

export type ServeHandle = { port: number; close: () => Promise<void> };

export function registerPhase0Jobs(scheduler: Scheduler, deps?: { config: AppConfig; calendar: ExchangeCalendar }): void {
  scheduler.register({
    jobId: "heartbeat",
    name: "Daily heartbeat ledger event",
    schedule: { kind: "daily_utc", hh: 0, mm: 0 },
    deadlineMs: 60_000,
    handler: (ctx) => {
      ctx.ledger.append("heartbeat", { scheduledFor: ctx.scheduledFor, version: CORE_VERSION }, ctx.now);
    },
  });

  scheduler.register({
    jobId: "seal_ledger",
    name: "Seal every unsealed UTC day older than the grace window",
    // Five past midnight UTC, after the heartbeat has landed in the new day. The offset keeps the two jobs
    // from sharing a scheduled instant and makes the log easier to read.
    schedule: { kind: "daily_utc", hh: 0, mm: 5 },
    deadlineMs: 120_000,
    handler: (ctx) => {
      // Seal the whole unsealed backlog, not just the newest eligible day.
      //
      // The scheduler records a run it could not perform as `missed` rather than running it late, so a Pi
      // that was powered off over a weekend would otherwise leave those days unsealed for good. Working the
      // backlog means one successful run repairs any such gap, which is safe because `sealDaily` is
      // idempotent.
      const throughDate = sealThroughDate(ctx.now);
      const pending = ctx.ledger.unsealedDates(throughDate);
      const sealed: string[] = [];
      for (const date of pending) {
        ctx.ledger.sealDaily(date, ctx.now);
        sealed.push(date);
      }
      if (sealed.length > 0) {
        ctx.ledger.append("ledger.sealed", { scheduledFor: ctx.scheduledFor, dates: sealed, throughDate }, ctx.now);
      }
    },
  });

  scheduler.register({
    jobId: "verify_integrity",
    name: "Full ledger + database integrity verification (moved off the health probe's hot path)",
    // Ten past midnight UTC, after the seal job at :05, so the day just sealed is included in the full check.
    schedule: { kind: "daily_utc", hh: 0, mm: 10 },
    deadlineMs: 300_000,
    handler: (ctx) => {
      // Runs the whole-store verification (chain + seals + PRAGMA integrity_check) and records the outcome for
      // the hot path to report. A finding is recorded, not thrown: the job's purpose is to verify and persist
      // the result, and health surfaces a failure via `full_verification`. See health/integrity.ts / HANDOFF §7.
      runFullVerification(ctx.db, ctx.ledger, ctx.now);
    },
  });

  // Opt-in incremental market-data ingest. Registered only when a charter path is configured and the calendar
  // is available (the serve loop and the run-jobs tick both provide deps). Fires after each session close.
  //
  // The cursor is computed PER SYMBOL from that symbol's own latest stored bar (planIncrementalIngest), not
  // from a source-wide maximum: a symbol that lags the rest of the universe (a newly added member, or one for
  // which a session returned no bar) is caught up from its own earliest missing session instead of being
  // skipped past. Symbols that share a range are fetched together; a symbol with no stored bar at all is left
  // for a manual `ingest universe` (the initial seed) and recorded, not silently ignored.
  //
  // Corporate actions are fetched only when autoIngestActions is "tiingo" (default "none"), and always BEFORE
  // the bars for the same range: the cursor is derived from stored bars, so bars must be the last thing
  // committed. If actions fail, the run is recorded failed with the bar cursor un-advanced, so the whole range
  // (actions included) is retried next session rather than the date's actions being skipped for good.
  //
  // It needs source credentials (env or secrets file); without them runIngest throws and the scheduler records
  // a failed run in the ledger - fail-closed, visible.
  const charterPath = deps?.config.sources.autoIngestCharterPath;
  if (deps !== undefined && charterPath !== undefined && charterPath !== "") {
    const { config, calendar } = deps;
    scheduler.register({
      jobId: "ingest_market_data",
      name: "Incremental market-data ingest for the configured charter universe",
      schedule: { kind: "after_close", offsetMs: 90 * 60_000 },
      deadlineMs: 15 * 60_000,
      handler: async (ctx) => {
        const c = loadCharterFile(charterPath).charter;
        const symbols = [...new Set([...charterUniverseMembers(c), c.benchmarks.primary, c.benchmarks.cash, ...c.benchmarks.secondary])]
          .filter((s) => s.trim().length > 0)
          .sort();
        const repo = new PointInTimeRepository(ctx.db, { processingDelayOverrides: processingDelayOverridesMs(config.sources) });
        const latestBySymbol = new Map(symbols.map((s) => [s, repo.latestAvailableAt(DEFAULT_BARS_SOURCE_ID, s)] as const));
        const plan = planIncrementalIngest(latestBySymbol, ctx.now, calendar);
        if (plan.groups.length === 0) {
          ctx.ledger.append(
            "ingest.skipped",
            {
              scheduledFor: ctx.scheduledFor,
              reason: "no new sessions to ingest for any configured symbol",
              source: DEFAULT_BARS_SOURCE_ID,
              symbolsUpToDate: plan.upToDate.length,
              symbolsWithoutData: plan.noData,
            },
            ctx.now,
          );
          return;
        }
        const withActions = config.sources.autoIngestActions === "tiingo";
        for (const group of plan.groups) {
          const csv = group.symbols.join(",");
          if (withActions) {
            await runIngest({ db: ctx.db, config, calendar }, parseIngestArgs(["tiingo-actions", "--symbols", csv, "--start", group.start, "--end", group.end]));
          }
          await runIngest({ db: ctx.db, config, calendar }, parseIngestArgs(["tiingo-bars", "--symbols", csv, "--start", group.start, "--end", group.end]));
        }
        // A symbol added to the charter but never seeded stays uningested here (the initial ingest is manual);
        // record it so the operator sees it needs a one-time `ingest universe`.
        if (plan.noData.length > 0) {
          ctx.ledger.append(
            "ingest.skipped",
            {
              scheduledFor: ctx.scheduledFor,
              reason: "symbols have no stored bars; run a manual `ingest universe` to seed them",
              source: DEFAULT_BARS_SOURCE_ID,
              symbolsWithoutData: plan.noData,
            },
            ctx.now,
          );
        }
      },
    });
  }

  // The mode-gated prospective shadow decision job (D-53 slice 2c). Registers itself only when a shadow
  // charter is configured AND the mode seals prospective decisions; see decision/shadow-job.ts.
  if (deps !== undefined) registerShadowDecisionJob(scheduler, deps);
}

/**
 * The next incremental ingest window for ONE symbol: from the first session AFTER its latest stored bar
 * through the latest completed session at `now`. Returns undefined when the symbol has no stored bar (its
 * initial ingest is a manual `ingest universe`) or when no session has closed since its latest stored bar.
 */
export function nextIngestRange(
  latestAvailable: UtcInstant | undefined,
  now: UtcInstant,
  calendar: ExchangeCalendar,
): { start: IsoDate; end: IsoDate } | undefined {
  if (latestAvailable === undefined) return undefined;
  const end = calendar.previousSession(now);
  const lastStored = calendar.previousSession(latestAvailable);
  if (end <= lastStored) return undefined;
  const start = calendar.nextSession(latestAvailable);
  if (start > end) return undefined;
  return { start, end };
}

export type IngestGroup = { start: IsoDate; end: IsoDate; symbols: string[] };
export type IncrementalIngestPlan = {
  /** Symbols that need new sessions, grouped by identical range so shared ranges fetch in one request. */
  groups: IngestGroup[];
  /** Symbols with no stored bar: they need a manual initial `ingest universe`, so they are skipped here. */
  noData: string[];
  /** Symbols already current through the latest completed session. */
  upToDate: string[];
};

/**
 * Plan an incremental ingest from each symbol's OWN latest stored bar, so a lagging or newly added symbol is
 * caught up from its earliest missing session rather than being skipped past by a source-wide maximum. Pure:
 * takes the per-symbol latest-available map and the calendar, returns the ranges to fetch and the symbols that
 * were skipped and why. Symbols sharing a range are grouped so the common "everyone missing today's session"
 * case is a single request; groups are ordered by start date.
 */
export function planIncrementalIngest(
  latestBySymbol: ReadonlyMap<string, UtcInstant | undefined>,
  now: UtcInstant,
  calendar: ExchangeCalendar,
): IncrementalIngestPlan {
  const byRange = new Map<string, IngestGroup>();
  const noData: string[] = [];
  const upToDate: string[] = [];
  for (const [symbol, latest] of latestBySymbol) {
    if (latest === undefined) {
      noData.push(symbol);
      continue;
    }
    const range = nextIngestRange(latest, now, calendar);
    if (range === undefined) {
      upToDate.push(symbol);
      continue;
    }
    const key = `${range.start}:${range.end}`;
    const group = byRange.get(key);
    if (group === undefined) byRange.set(key, { start: range.start, end: range.end, symbols: [symbol] });
    else group.symbols.push(symbol);
  }
  const groups = [...byRange.values()]
    .map((g) => ({ start: g.start, end: g.end, symbols: [...g.symbols].sort() }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { groups, noData: noData.sort(), upToDate: upToDate.sort() };
}

export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  const clock = opts.clock ?? (() => nowUtc());
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const ledger = new Ledger(opts.db);
  const scheduler = new Scheduler({
    db: opts.db,
    ledger,
    calendar: opts.calendar,
    dueLookbackMs: 24 * 3_600_000,
    missedLookbackMs: 7 * 24 * 3_600_000,
  });
  registerPhase0Jobs(scheduler, { config: opts.config, calendar: opts.calendar });

  // Run one full verification at startup so the hot path has a fresh result immediately, rather than reporting
  // "no full verification recorded yet" until the first daily job fires (up to a day later). Startup is not the
  // 60 s hot path, so the full scan here is fine; the daily job maintains it from then on.
  runFullVerification(opts.db, ledger, clock());

  let lastReport: HealthReport | undefined;
  const refreshHealth = (): HealthReport => {
    lastReport = runHealth(opts.config, opts.db, opts.calendar, clock());
    return lastReport;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain" });
      res.end("read-only");
      return;
    }
    if (req.url === "/health") {
      const report = refreshHealth();
      res.writeHead(report.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(report));
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      // The HTML page always refreshes rather than serving `lastReport`: a stale "OK" on a dashboard is worse
      // than a slow one, and the operator opening this page is asking what is true now.
      const html = renderStatusPage(buildStatusReport(opts.db, refreshHealth()));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // Defence in depth for a page that is already script-free and makes no outbound request. If a future
        // change introduces either, this refuses it rather than silently allowing it.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
      res.end(html);
      return;
    }
    // Kept for terminals and `curl` on the Pi, where the HTML page is unreadable.
    if (req.url === "/status.txt") {
      const report = lastReport ?? refreshHealth();
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(renderStatus(report));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.config.httpPort, () => {
      server.off("error", reject);
      resolve();
    });
  });
  log(`blackgold-core ${CORE_VERSION} serving read-only status on :${opts.config.httpPort} (mode ${opts.config.mode}, liveCapable=false)`);

  let stopping = false;
  let ticking = false;
  const tickOnce = async (): Promise<void> => {
    if (ticking || stopping) return;
    ticking = true;
    try {
      const now = clock();
      const missed = scheduler.detectMissedRuns(now);
      const outcomes = await scheduler.tick(now);
      if (missed.length > 0 || outcomes.length > 0) {
        log(JSON.stringify({ at: now, missed: missed.length, outcomes: outcomes.map((o) => `${o.jobId}:${o.status}`) }));
      }
    } catch (err) {
      log(JSON.stringify({ at: clock(), schedulerError: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
    } finally {
      ticking = false;
    }
  };
  await tickOnce();
  const interval = setInterval(() => {
    void tickOnce();
  }, opts.config.schedulerPollSeconds * 1000);

  const close = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    log("blackgold-core stopped");
  };
  opts.shutdownSignal?.addEventListener("abort", () => {
    void close();
  });
  return { port: opts.config.httpPort, close };
}

function renderStatus(r: HealthReport): string {
  const lines = [
    `Black Gold core ${r.version}`,
    `status: ${r.ok ? "OK" : "DEGRADED"}`,
    `mode: ${r.mode}   liveCapable: ${String(r.liveCapable)}`,
    `as of: ${r.at}`,
    `next session: ${r.nextSession}`,
    `ledger events: ${r.ledgerEvents}   chain (unsealed tail): ${r.ledgerChain.ok ? "ok" : "BROKEN"}`,
    `full verification: ${r.lastFullVerification ? `${r.lastFullVerification.ok ? "clear" : "FAILED"} at ${r.lastFullVerification.at}` : "pending"}`,
    `last seal: ${r.lastSeal ? `${r.lastSeal.date} ${r.lastSeal.rootHash.slice(0, 12)}` : "none"}`,
    `unsealed days: ${r.unsealedDays.length === 0 ? "none" : r.unsealedDays.join(",")}`,
    "",
    "checks:",
    ...r.checks.map((c) => `  [${c.ok ? "ok" : "FAIL"}] ${c.component}: ${c.detail}`),
    "",
    "No positions, no broker, no model provider in this build. This page is read-only.",
  ];
  return lines.join("\n");
}
