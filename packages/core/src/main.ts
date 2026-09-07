#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { isoDate, nowUtc, dateOfInstantInZone, addDays, type Db, type IsoDate } from "@blackgold/shared";
import { loadAppConfig, type AppConfig } from "./config/load.ts";
import { openCoreDb } from "./db/open.ts";
import { backupDatabase, verifyRestore } from "./db/backup.ts";
import { Ledger } from "./ledger/ledger.ts";
import { NyseCalendar } from "./calendar/nyse.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { runHealth } from "./health/health.ts";
import { CORE_PACKAGE_NAME, CORE_VERSION } from "./version.ts";

/**
 * blackgold-core CLI. Phase 0 surface: operational commands only. No broker, no model, no live path.
 * Exit code 0 on success, 1 on failure or an unhealthy report, 2 on usage error.
 */

const USAGE = `${CORE_PACKAGE_NAME} ${CORE_VERSION}

Usage: blackgold-core <command> [args]

  health                 Run health checks, print JSON, exit 1 if unhealthy
  migrate                Apply pending database migrations
  backup                 Online backup to backupsDir, integrity-checked
  verify-backup <path>   Restore drill: integrity + ledger chain + seals on a copy
  seal [YYYY-MM-DD]      Seal the ledger for a UTC date (default: yesterday UTC)
  verify-chain           Verify the ledger hash chain and seals
  run-jobs               One scheduler tick (missed-run detection, then due runs)
  version                Print the package version

Configuration comes from BLACKGOLD_* environment variables (see config/schema/README.md).`;

type CommandResult = { exitCode: number; output: unknown };

function withDb<T>(config: AppConfig, fn: (db: Db) => T): T {
  mkdirSync(config.dataDir, { recursive: true });
  const { db } = openCoreDb(config);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function run(argv: readonly string[]): Promise<CommandResult> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { exitCode: command === undefined ? 2 : 0, output: USAGE };
  }
  if (command === "version") return { exitCode: 0, output: { name: CORE_PACKAGE_NAME, version: CORE_VERSION } };

  const config = loadAppConfig();
  const calendar = new NyseCalendar();
  const now = nowUtc();

  switch (command) {
    case "health": {
      const report = withDb(config, (db) => runHealth(config, db, calendar, now));
      return { exitCode: report.ok ? 0 : 1, output: report };
    }
    case "migrate": {
      mkdirSync(config.dataDir, { recursive: true });
      const { db, applied } = openCoreDb(config);
      db.close();
      return { exitCode: 0, output: { dbPath: config.dbPath, applied } };
    }
    case "backup": {
      const result = withDb(config, (db) => backupDatabase(db, config.backupsDir, now));
      return { exitCode: result.ok ? 0 : 1, output: result };
    }
    case "verify-backup": {
      const path = args[0];
      if (path === undefined) return { exitCode: 2, output: "verify-backup requires a path" };
      const report = verifyRestore(path);
      return { exitCode: report.ok ? 0 : 1, output: report };
    }
    case "seal": {
      const date: IsoDate = args[0] === undefined ? addDays(dateOfInstantInZone(now, "UTC"), -1) : isoDate(args[0]);
      const seal = withDb(config, (db) => new Ledger(db).sealDaily(date, now));
      return { exitCode: 0, output: seal };
    }
    case "verify-chain": {
      const result = withDb(config, (db) => {
        const ledger = new Ledger(db);
        return { chain: ledger.verifyChain(), seals: ledger.verifySeals(), events: ledger.count() };
      });
      return { exitCode: result.chain.ok && result.seals.ok ? 0 : 1, output: result };
    }
    case "run-jobs": {
      mkdirSync(config.dataDir, { recursive: true });
      const { db } = openCoreDb(config);
      try {
        const ledger = new Ledger(db);
        // Phase 0: a single manual tick. The daily heartbeat may be caught up within the day, so the due
        // window is one day; anything older than that is reported as missed, never run late.
        const scheduler = new Scheduler({ db, ledger, calendar, dueLookbackMs: 24 * 3_600_000, missedLookbackMs: 7 * 24 * 3_600_000 });
        scheduler.register({
          jobId: "heartbeat",
          name: "Daily heartbeat ledger event",
          schedule: { kind: "daily_utc", hh: 0, mm: 0 },
          deadlineMs: 60_000,
          handler: (ctx) => {
            ctx.ledger.append("heartbeat", { scheduledFor: ctx.scheduledFor, version: CORE_VERSION }, ctx.now);
          },
        });
        const missed = scheduler.detectMissedRuns(now);
        const outcomes = await scheduler.tick(now);
        const failed = outcomes.some((o) => o.status === "failed");
        return { exitCode: failed ? 1 : 0, output: { now, missed, outcomes } };
      } finally {
        db.close();
      }
    }
    default:
      return { exitCode: 2, output: `Unknown command: ${command}\n\n${USAGE}` };
  }
}

function print(value: unknown, toStderr = false): void {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (toStderr) process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

run(process.argv.slice(2)).then(
  (result) => {
    print(result.output, result.exitCode === 2);
    process.exitCode = result.exitCode;
  },
  (err: unknown) => {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    print({ ok: false, error: message }, true);
    process.exitCode = 1;
  },
);
