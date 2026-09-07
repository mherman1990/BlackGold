import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { addDays, dateOfInstantInZone, nowUtc, type Db, type UtcInstant } from "@blackgold/shared";
import type { AppConfig } from "./config/schema.ts";
import type { ExchangeCalendar } from "./calendar/types.ts";
import { Ledger } from "./ledger/ledger.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { runHealth, type HealthReport } from "./health/health.ts";
import { CORE_VERSION } from "./version.ts";

/**
 * Long-running core process for the Umbrel container.
 *
 * - A LOCAL, read-only HTTP status listener (GET /health as JSON, GET / as a plain status page). It binds to
 *   all container interfaces because Umbrel's app_proxy is the only route to it; it never makes outbound
 *   requests and accepts no state-changing method.
 * - A scheduler loop that ticks every `schedulerPollSeconds`, running missed-run detection before due runs.
 *
 * Phase 0 registers one job (the daily heartbeat). Nothing here touches a broker or a model provider.
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

export function registerPhase0Jobs(scheduler: Scheduler): void {
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
    name: "Seal every unsealed UTC day up to yesterday",
    // Five past midnight UTC, after the heartbeat has landed in the new day. Sealing yesterday can never
    // race the heartbeat's own event, which belongs to today, but the offset keeps the two jobs from
    // sharing a scheduled instant and makes the log easier to read.
    schedule: { kind: "daily_utc", hh: 0, mm: 5 },
    deadlineMs: 120_000,
    handler: (ctx) => {
      // Seal the whole unsealed backlog, not just yesterday.
      //
      // The scheduler records a run it could not perform as `missed` rather than running it late, so a Pi
      // that was powered off over a weekend would otherwise leave those days unsealed for good. Working the
      // backlog means one successful run repairs any such gap. `sealDaily` is idempotent, so re-sealing an
      // unchanged day is a no-op; a day whose events changed after sealing throws SealMismatchError, which
      // is the tamper signal and must propagate rather than be swallowed here.
      const yesterday = addDays(dateOfInstantInZone(ctx.now, "UTC"), -1);
      const pending = ctx.ledger.unsealedDates(yesterday);
      const sealed: string[] = [];
      for (const date of pending) {
        ctx.ledger.sealDaily(date, ctx.now);
        sealed.push(date);
      }
      if (sealed.length > 0) {
        ctx.ledger.append("ledger.sealed", { scheduledFor: ctx.scheduledFor, dates: sealed, throughDate: yesterday }, ctx.now);
      }
    },
  });
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
  registerPhase0Jobs(scheduler);

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
    `ledger events: ${r.ledgerEvents}   chain: ${r.ledgerChain.ok ? "ok" : "BROKEN"}`,
    `last seal: ${r.lastSeal ? `${r.lastSeal.date} ${r.lastSeal.rootHash.slice(0, 12)}` : "none"}`,
    "",
    "checks:",
    ...r.checks.map((c) => `  [${c.ok ? "ok" : "FAIL"}] ${c.component}: ${c.detail}`),
    "",
    "No positions, no broker, no model provider in this build. This page is read-only.",
  ];
  return lines.join("\n");
}
