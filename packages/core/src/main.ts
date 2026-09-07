#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { Dec, isoDate, nowUtc, dateOfInstantInZone, addDays, utc, type Db, type IsoDate } from "@blackgold/shared";
import { loadAppConfig, loadYamlConfig, readAnthropicApiKey, type AppConfig } from "./config/load.ts";
import { ModelManifestConfigSchema, processingDelayOverridesMs } from "./config/schema.ts";
import { AnthropicAdapter } from "./model/anthropic.ts";
import { CircuitBreaker } from "./model/assess.ts";
import { pricingFrom, resolveModelEntry } from "./model/manifest.ts";
import { ANALYST_SYSTEM_PROMPT, runAnalyst } from "./analyst/run-analyst.ts";
import { verifyArtifacts } from "./data/artifacts/verify.ts";
import { openCoreDb } from "./db/open.ts";
import { backupDatabase, verifyRestore } from "./db/backup.ts";
import { Ledger } from "./ledger/ledger.ts";
import { NyseCalendar } from "./calendar/nyse.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { runHealth } from "./health/health.ts";
import { serve, registerPhase0Jobs } from "./serve.ts";
import { CORE_PACKAGE_NAME, CORE_VERSION } from "./version.ts";
import { ArtifactStore } from "./data/artifacts/store.ts";
import { PointInTimeRepository } from "./data/pit/repository.ts";
import { INGEST_USAGE, parseIngestArgs, parseOptions, runIngest, UsageError } from "./ingest/run.ts";
import { admittedRiskEtfs, charterUniverseMembers, loadCharterFile, registrabilityReasons } from "./strategy/charter.ts";
import { splitPlan } from "./research/walkforward.ts";
import { enumerateGrid, enumerateTiers } from "./research/robustness.ts";
import { buildCoverageReport } from "./research/coverage.ts";

/**
 * blackgold-core CLI. Operational commands plus Phase 1 public-source ingestion. No broker, no model, no live path.
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
  serve                  Long-running: local read-only status listener plus the scheduler loop
  version                Print the package version

Phase 1 research kernel (public sources only; requires BLACKGOLD_SEC_USER_AGENT_CONTACT):
  ${INGEST_USAGE.split("\n").join("\n  ")}
  pit count [--source <id>]                 Count stored observations
  pit latest --source <id> [--entity <id>]  Newest availableAt and the newest row for a source
  snapshot create --dataset <name> --description <text>
  artifacts verify [--sample N]             Verify stored artifacts; failures quarantine referencing rows (default sample 100)

Phase 2 research (deterministic charters only; computes nothing that a DRAFT charter may cite as evidence):
  charter show --path <charter.yaml>        Parse, hash, and report whether the charter may be registered
  charter plan --path <charter.yaml>        Evaluation plan: design, walk-forward and recent splits, sealed holdout, grid and tiers
  research coverage --path <charter.yaml> --from <date> --to <date>
                                            Point-in-time coverage report for the charter universe

Phase 3 runtime-LLM analyst (requires ANTHROPIC_API_KEY in the environment; abstains fail-closed without it):
  research analyst --manifest <model-manifest.yaml> --model <id> --candidate <SYMBOL> --at <iso-instant>
                   --sources <sourceId[:entityId],...> [--factors <name,...>] [--mode historical]
                                            One analyst decision: seal a point-in-time packet, assess, archive the call

Configuration comes from BLACKGOLD_* environment variables (see config/schema/README.md).`;

type CommandResult = { exitCode: number; output: unknown };

/** Every repository the CLI builds carries the configured processing-delay overrides. */
function pitRepository(db: Db, config: AppConfig): PointInTimeRepository {
  return new PointInTimeRepository(db, { processingDelayOverrides: processingDelayOverridesMs(config.sources) });
}

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
        registerPhase0Jobs(scheduler);
        const missed = scheduler.detectMissedRuns(now);
        const outcomes = await scheduler.tick(now);
        const failed = outcomes.some((o) => o.status === "failed");
        return { exitCode: failed ? 1 : 0, output: { now, missed, outcomes } };
      } finally {
        db.close();
      }
    }
    case "ingest": {
      const request = parseIngestArgs(args);
      mkdirSync(config.dataDir, { recursive: true });
      const { db } = openCoreDb(config);
      try {
        const report = await runIngest({ db, config, calendar }, request);
        return { exitCode: 0, output: report };
      } finally {
        db.close();
      }
    }
    case "pit": {
      const [sub, ...rest] = args;
      if (sub === "count") {
        const o = parseOptions(rest, { source: { type: "string" } });
        const source = typeof o["source"] === "string" ? o["source"] : undefined;
        const n = withDb(config, (db) => pitRepository(db, config).count(source));
        return { exitCode: 0, output: { source: source ?? "*", observations: n } };
      }
      if (sub === "latest") {
        const o = parseOptions(rest, { source: { type: "string" }, entity: { type: "string" } });
        const source = o["source"];
        if (typeof source !== "string") throw new UsageError("pit latest requires --source <id>");
        const entity = typeof o["entity"] === "string" ? o["entity"] : undefined;
        const out = withDb(config, (db) => {
          const repo = pitRepository(db, config);
          const rows = repo.all(source, entity);
          return { source, entity: entity ?? "*", count: rows.length, latestAvailableAt: repo.latestAvailableAt(source, entity) ?? null, newestRow: rows.at(-1) ?? null };
        });
        return { exitCode: 0, output: out };
      }
      throw new UsageError("pit requires a subcommand: count | latest");
    }
    case "snapshot": {
      const [sub, ...rest] = args;
      if (sub !== "create") throw new UsageError("snapshot requires the subcommand: create");
      const o = parseOptions(rest, { dataset: { type: "string" }, description: { type: "string" } });
      const dataset = o["dataset"];
      const description = o["description"];
      if (typeof dataset !== "string" || typeof description !== "string") throw new UsageError("snapshot create requires --dataset and --description");
      const snapshot = withDb(config, (db) => pitRepository(db, config).createSnapshot(dataset, description));
      return { exitCode: 0, output: snapshot };
    }
    case "artifacts": {
      const [sub, ...rest] = args;
      if (sub !== "verify") throw new UsageError("artifacts requires the subcommand: verify");
      const o = parseOptions(rest, { sample: { type: "string" } });
      const sample = typeof o["sample"] === "string" ? Number.parseInt(o["sample"], 10) : 100;
      if (!Number.isInteger(sample) || sample <= 0) throw new UsageError("--sample must be a positive integer");
      // Failures quarantine every referencing observation (ARTIFACT_MISSING) and are recorded in the ledger.
      const result = withDb(config, (db) =>
        verifyArtifacts({ store: new ArtifactStore(config.artifactsDir, db), repo: pitRepository(db, config), ledger: new Ledger(db) }, { sample }),
      );
      return { exitCode: result.failed.length === 0 ? 0 : 1, output: result };
    }
    case "charter": {
      const [sub, ...rest] = args;
      const o = parseOptions(rest, { path: { type: "string" } });
      const path = o["path"];
      if (typeof path !== "string") throw new UsageError("charter requires --path <charter.yaml>");
      const loaded = loadCharterFile(path);
      if (sub === "show") {
        const reasons = registrabilityReasons(loaded.charter);
        return {
          exitCode: 0,
          output: {
            strategyId: loaded.charter.strategy_id,
            charterVersion: loaded.charter.charter_version,
            charterHash: loaded.charterHash,
            approvalState: loaded.charter.approval.state,
            registrable: reasons.length === 0,
            reasons,
            admittedRiskEtfs: admittedRiskEtfs(loaded.charter),
            universeMembers: charterUniverseMembers(loaded.charter),
          },
        };
      }
      if (sub === "plan") {
        const plan = splitPlan(loaded.charter);
        const grid = enumerateGrid(loaded.charter);
        return {
          exitCode: 0,
          output: {
            charterHash: loaded.charterHash,
            planHash: plan.planHash,
            splits: plan.splits.map((sp) => ({ id: sp.id, kind: sp.kind, evaluation: sp.evaluation })),
            holdout: plan.holdout,
            trialCount: grid.trialCount,
            registeredGridIndex: grid.registeredIndex,
            sensitivityTiers: enumerateTiers(loaded.charter).map((t) => t.id),
            registrable: registrabilityReasons(loaded.charter).length === 0,
          },
        };
      }
      throw new UsageError("charter requires a subcommand: show | plan");
    }
    case "research": {
      const [sub, ...rest] = args;
      if (sub === "analyst") {
        const o = parseOptions(rest, {
          manifest: { type: "string" }, model: { type: "string" }, candidate: { type: "string" }, at: { type: "string" },
          sources: { type: "string" }, factors: { type: "string" }, "strategy-id": { type: "string" },
          "strategy-version": { type: "string" }, "prompt-version": { type: "string" }, mode: { type: "string" },
        });
        const manifest = o["manifest"];
        const modelId = o["model"];
        const candidate = o["candidate"];
        const at = o["at"];
        const sourcesCsv = o["sources"];
        if (typeof manifest !== "string" || typeof modelId !== "string" || typeof candidate !== "string" || typeof at !== "string" || typeof sourcesCsv !== "string") {
          throw new UsageError("research analyst requires --manifest <path> --model <id> --candidate <SYMBOL> --at <iso-instant> --sources <sourceId[:entityId],...>");
        }
        const key = readAnthropicApiKey();
        if (key === undefined) {
          return { exitCode: 2, output: "ANTHROPIC_API_KEY is not set; the analyst cannot call the model. Set it in the app environment (never in git), then retry." };
        }
        const manifestConfig = loadYamlConfig(manifest, ModelManifestConfigSchema);
        const entry = resolveModelEntry(manifestConfig, modelId, { now: new Date(now), maxAgeDays: 90 });
        const sources = sourcesCsv.split(",").map((s) => s.trim()).filter((s) => s !== "").map((s) => {
          const [sourceId, entityId] = s.split(":");
          return entityId !== undefined && entityId !== "" ? { sourceId: sourceId ?? s, entityId } : { sourceId: sourceId ?? s };
        });
        const factors = new Set((typeof o["factors"] === "string" ? o["factors"] : "").split(",").map((s) => s.trim()).filter((s) => s !== ""));
        const runMode = o["mode"] === "historical" ? "HISTORICAL_REPLAY" : "PROSPECTIVE";
        mkdirSync(config.dataDir, { recursive: true });
        const { db } = openCoreDb(config);
        try {
          const outcome = await runAnalyst({
            db,
            pit: pitRepository(db, config),
            adapter: new AnthropicAdapter(entry.modelId, key),
            breaker: new CircuitBreaker(3),
            pricing: pricingFrom(entry),
            budgets: { perCallUsd: new Dec(config.budgets.llmPerCallUsd), perDayUsd: new Dec(config.budgets.llmPerDayUsd), perMonthUsd: new Dec(config.budgets.llmPerMonthUsd) },
            now,
            strategyId: typeof o["strategy-id"] === "string" ? o["strategy-id"] : "adhoc",
            strategyVersion: typeof o["strategy-version"] === "string" ? o["strategy-version"] : "adhoc",
            candidateId: candidate,
            decisionAt: utc(at),
            sources,
            excerpt: (obs) => JSON.stringify(obs.value).slice(0, 800),
            deterministicFactors: factors,
            prompt: { version: typeof o["prompt-version"] === "string" ? o["prompt-version"] : "analyst-1", text: ANALYST_SYSTEM_PROMPT },
            deadlineMs: 60_000,
            maxAttempts: 2,
            runMode,
          });
          return { exitCode: 0, output: outcome };
        } finally {
          db.close();
        }
      }
      if (sub !== "coverage") throw new UsageError("research requires a subcommand: coverage | analyst");
      const o = parseOptions(rest, { path: { type: "string" }, from: { type: "string" }, to: { type: "string" } });
      const path = o["path"];
      const from = o["from"];
      const to = o["to"];
      if (typeof path !== "string" || typeof from !== "string" || typeof to !== "string") {
        throw new UsageError("research coverage requires --path, --from and --to");
      }
      const loaded = loadCharterFile(path);
      const decisionAt = calendar.sessionClose(calendar.previousSession(utc(`${isoDate(to)}T23:59:59Z`)));
      const report = withDb(config, (db) =>
        buildCoverageReport({
          pit: pitRepository(db, config),
          calendar,
          entities: charterUniverseMembers(loaded.charter),
          from: isoDate(from),
          to: isoDate(to),
          decisionAt,
        }),
      );
      return { exitCode: report.uncovered.length === 0 ? 0 : 1, output: report };
    }
    case "serve": {
      mkdirSync(config.dataDir, { recursive: true });
      const { db } = openCoreDb(config);
      const controller = new AbortController();
      const handle = await serve({ config, db, calendar, shutdownSignal: controller.signal });
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          controller.abort();
          handle.close().then(
            () => {
              db.close();
              resolve();
            },
            () => {
              db.close();
              resolve();
            },
          );
        };
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
      });
      return { exitCode: 0, output: "stopped" };
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
    process.exitCode = err instanceof UsageError ? 2 : 1;
  },
);
