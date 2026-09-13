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
import { INGEST_USAGE, parseIngestArgs, parseOptions, resolveUniverseIngest, runIngest, UsageError } from "./ingest/run.ts";
import { admittedRiskEtfs, charterRange, charterUniverseMembers, loadCharterFile, registrabilityReasons } from "./strategy/charter.ts";
import { classifyCandidateFactors } from "./strategy/factors.ts";
import { splitPlan, type SplitKind } from "./research/walkforward.ts";
import { enumerateGrid, enumerateTiers } from "./research/robustness.ts";
import { buildCoverageReport } from "./research/coverage.ts";
import { runEvaluation, type EvaluationProgress } from "./research/evaluate.ts";

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
  research coverage --path <charter.yaml> --from <date> --to <date> [--source <bars-source-id>]
                                            Point-in-time coverage report for the charter universe
                                            (--source measures a specific bars source, e.g. tiingo.eod.bars.1d; default alpaca.iex.bars.1d)
  research evaluate --path <charter.yaml> [--source <bars-source-id>] [--split design|walk-forward|recent]
                                            Deterministic backtest over the charter's design, walk-forward and recent splits
                                            (never the sealed holdout); emits a per-split result report. Numbers only: a run over
                                            promotion-ineligible data (e.g. single-source) is reported uncitable as evidence.
                                            --split (comma-separated) runs only those kinds; progress is printed to stderr.

Phase 3 runtime-LLM analyst (requires ANTHROPIC_API_KEY in the environment; abstains fail-closed without it):
  research analyst --manifest <model-manifest.yaml> --model <id> --candidate <SYMBOL> --at <iso-instant>
                   --sources <sourceId[:entityId],...> --charter <charter.yaml> [--mode historical]
                                            One analyst decision: seal a point-in-time packet, assess, archive the call.
                                            Factors are classified deterministically from the charter; an unclassified candidate is refused

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
      if (args[0] === "universe") {
        // Convenience wrapper: ingest every symbol the charter reads (admitted risk ETFs + cash + benchmarks)
        // over its window span in one command, instead of listing symbols and dates by hand. Reads the charter
        // only; the fetch itself goes through the same allowlisted runIngest path as a single-source ingest.
        const o = parseOptions(args.slice(1), { charter: { type: "string" }, start: { type: "string" }, end: { type: "string" }, source: { type: "string" }, actions: { type: "string" } });
        const charterPath = o["charter"];
        if (typeof charterPath !== "string") {
          throw new UsageError("ingest universe requires --charter <charter.yaml> --actions <tiingo|none> [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--source tiingo|alpaca]");
        }
        const loaded = loadCharterFile(charterPath);
        const c = loaded.charter;
        const members = [...charterUniverseMembers(c), c.benchmarks.primary, c.benchmarks.cash, ...c.benchmarks.secondary];
        const ranges = (["design", "holdout", "recent"] as const).map((seg) => charterRange(c, seg));
        const plan = resolveUniverseIngest(members, ranges, {
          start: typeof o["start"] === "string" ? o["start"] : undefined,
          end: typeof o["end"] === "string" ? o["end"] : undefined,
          source: typeof o["source"] === "string" ? o["source"] : undefined,
          actions: typeof o["actions"] === "string" ? o["actions"] : undefined,
        });
        const csv = plan.symbols.join(",");
        const requests = [parseIngestArgs([plan.source === "tiingo" ? "tiingo-bars" : "alpaca-bars", "--symbols", csv, "--start", plan.start, "--end", plan.end])];
        // Corporate actions only when the operator explicitly asked for the Tiingo automated path. `none` leaves
        // them to a reconciled vendored file (ingest corporate-actions --file), so a run cannot double-count a
        // dividend/split by ingesting both the Tiingo and the vendored observation for the same event.
        if (plan.actions === "tiingo") requests.push(parseIngestArgs(["tiingo-actions", "--symbols", csv, "--start", plan.start, "--end", plan.end]));
        mkdirSync(config.dataDir, { recursive: true });
        const { db } = openCoreDb(config);
        try {
          const reports: { source: string; report: Awaited<ReturnType<typeof runIngest>> }[] = [];
          for (const request of requests) reports.push({ source: request.source, report: await runIngest({ db, config, calendar }, request) });
          return { exitCode: 0, output: { charterHash: loaded.charterHash, source: plan.source, actions: plan.actions, symbols: plan.symbols, start: plan.start, end: plan.end, reports } };
        } finally {
          db.close();
        }
      }
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
          sources: { type: "string" }, charter: { type: "string" }, "strategy-id": { type: "string" },
          "strategy-version": { type: "string" }, "prompt-version": { type: "string" }, mode: { type: "string" },
        });
        const manifest = o["manifest"];
        const modelId = o["model"];
        const candidate = o["candidate"];
        const at = o["at"];
        const sourcesCsv = o["sources"];
        const charterPath = o["charter"];
        if (typeof manifest !== "string" || typeof modelId !== "string" || typeof candidate !== "string" || typeof at !== "string" || typeof sourcesCsv !== "string" || typeof charterPath !== "string") {
          throw new UsageError("research analyst requires --manifest <path> --model <id> --candidate <SYMBOL> --at <iso-instant> --sources <sourceId[:entityId],...> --charter <charter.yaml>");
        }
        // Code, not the operator, decides which factors the candidate touches (T-05). An unknown classification
        // fails closed: no model call is made, matching "unknown factor classification blocks new risk".
        const loadedCharter = loadCharterFile(charterPath);
        const classification = classifyCandidateFactors(loadedCharter.charter, candidate);
        if (!classification.classified) {
          return { exitCode: 2, output: `Candidate ${candidate} has no deterministic factor classification in ${charterPath}; unknown factor classification blocks new risk. Assign its factors in the charter (a new charter version) before assessing it.` };
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
        const factors = classification.factors;
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
            strategyId: typeof o["strategy-id"] === "string" ? o["strategy-id"] : loadedCharter.charter.strategy_id,
            strategyVersion: typeof o["strategy-version"] === "string" ? o["strategy-version"] : loadedCharter.charter.charter_version,
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
      if (sub === "evaluate") {
        const o = parseOptions(rest, { path: { type: "string" }, source: { type: "string" }, split: { type: "string" } });
        const path = o["path"];
        if (typeof path !== "string") throw new UsageError("research evaluate requires --path <charter.yaml> [--source <bars-source-id>] [--split design|walk-forward|recent]");
        const source = o["source"];
        // Optional --split filter: a comma-separated list of split kinds. Lets an operator run just the design
        // split (or just recent) instead of the full sweep, which matters on a Pi where the full run is slow.
        const splitAliases: Record<string, SplitKind> = { design: "DESIGN", "walk-forward": "WALK_FORWARD", walkforward: "WALK_FORWARD", wf: "WALK_FORWARD", recent: "RECENT" };
        let splitKinds: SplitKind[] | undefined;
        if (typeof o["split"] === "string") {
          const requested = o["split"].split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
          const mapped: SplitKind[] = [];
          for (const r of requested) {
            const kind = splitAliases[r];
            if (kind === undefined) throw new UsageError(`unknown --split value "${r}"; valid: design, walk-forward, recent`);
            if (!mapped.includes(kind)) mapped.push(kind);
          }
          splitKinds = mapped;
        }
        const loaded = loadCharterFile(path);
        // Registrability is threaded, not enforced: running a DRAFT charter on fixtures is legitimate, and the
        // result carries the reasons it may not be cited. Signing a charter is outside standing authorization.
        const reasons = registrabilityReasons(loaded.charter);
        // Progress goes to stderr so stdout stays the clean JSON report; the timing is a side channel only.
        let splitStartedAt = 0;
        const onProgress = (e: EvaluationProgress): void => {
          if (e.phase === "start") process.stderr.write(`[evaluate] ${e.total} split(s) to run\n`);
          else if (e.phase === "split-start") { splitStartedAt = Date.now(); process.stderr.write(`[evaluate] split ${e.index + 1}/${e.total} ${e.kind} ${e.splitId} ...\n`); }
          else if (e.phase === "split-done") process.stderr.write(`[evaluate] split ${e.index + 1}/${e.total} ${e.kind} done in ${((Date.now() - splitStartedAt) / 1000).toFixed(1)}s\n`);
          else process.stderr.write(`[evaluate] all ${e.total} split(s) done\n`);
        };
        const report = withDb(config, (db) =>
          runEvaluation({
            charter: loaded.charter,
            charterHash: loaded.charterHash,
            registrabilityReasons: reasons,
            pit: pitRepository(db, config),
            calendar,
            onProgress,
            ...(typeof source === "string" ? { barsSourceId: source } : {}),
            ...(splitKinds === undefined ? {} : { splitKinds }),
          }),
        );
        return { exitCode: report.splits.length > 0 ? 0 : 1, output: report };
      }
      if (sub !== "coverage") throw new UsageError("research requires a subcommand: coverage | analyst | evaluate");
      const o = parseOptions(rest, { path: { type: "string" }, from: { type: "string" }, to: { type: "string" }, source: { type: "string" } });
      const path = o["path"];
      const from = o["from"];
      const to = o["to"];
      // Optional: measure coverage for a specific bars source id (e.g. tiingo.eod.bars.1d) instead of the
      // default. A diagnostic only - it does not change which source the charter uses.
      const source = o["source"];
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
          ...(typeof source === "string" ? { barsSourceId: source } : {}),
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
