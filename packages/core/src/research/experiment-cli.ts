import { writeFileSync } from "node:fs";
import { isoDate, nowUtc, utc, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import { processingDelayOverridesMs, type AppConfig } from "../config/schema.ts";
import { defaultProcessingDelayMs, PointInTimeRepository } from "../data/pit/repository.ts";
import { NO_SHADOW_CLOCK_LABEL, sealsProspectiveDecisions } from "../decision/decision-record.ts";
import { Ledger } from "../ledger/ledger.ts";
import { DEFAULT_BARS_SOURCE_ID } from "../market/series.ts";
import { assertRegistrable, loadCharterFile, charterUniverseMembers, type Charter, type LoadedCharter } from "../strategy/charter.ts";
import { buildCoverageReport, type CoverageReport } from "./coverage.ts";
import { ExperimentRegistry, type ExperimentDefinitionInput, type ExperimentRecord } from "./registry.ts";
import { enumerateGrid } from "./robustness.ts";

/**
 * The owner's `experiment` CLI (plan B1; D-60 item 4; OD-10). Everything here is a parameter: this module reads
 * no environment (`config/` does that) and the signer always arrives typed on the command line.
 *
 * The acts this module performs are the owner's. Claude Code builds the line and runs `--dry-run`; it never
 * registers, marks a result viewed, or opens the holdout (CLAUDE.md, "What standing authorization never covers").
 * The gate is procedural, not cryptographic: it refuses placeholder signers and requires an explicit name.
 */

export const REPO_SLUG = "mherman1990/BlackGold";

/** Values that are a role, a placeholder or an agent, never a person who signs. Compared lower-cased, trimmed. */
export const SIGNER_PLACEHOLDERS: readonly string[] = [
  "owner",
  "the owner",
  "operator",
  "admin",
  "user",
  "me",
  "name",
  "your name",
  "signer",
  "none",
  "n/a",
  "null",
  "undefined",
  "anonymous",
  "bot",
  "agent",
  "ai",
  "assistant",
  "system",
  "ci",
  "github actions",
  "matt herman (default)",
];

/** A word that marks an agent, a default or an unanswered question rather than a signer. */
const NOT_A_SIGNER = /\b(claude|anthropic|codex|copilot|gpt|openai|llm|silence|silent|default|auto|unanswered|placeholder|todo|tbd|fixme|example|sample|test|tester|dummy)\b/i;

export class SignerError extends Error {
  constructor(flag: string, value: string | undefined, why: string) {
    super(`${flag} ${value === undefined ? "is required" : `"${value}" is refused`}: ${why}`);
    this.name = "SignerError";
  }
}

/**
 * The signer of an owner act, exactly as typed. Refuses nothing typed, a blank, an unexpanded `$VARIABLE`, an
 * angle-bracket placeholder, a role word and anything naming an agent or a default. Returns the trimmed value.
 */
export function validateSigner(value: string | undefined, flag: string): string {
  if (value === undefined) throw new SignerError(flag, value, "an owner act carries the owner's name, typed on the line");
  const v = value.trim();
  if (v.length === 0) throw new SignerError(flag, value, "a blank is not a signer");
  if (v.includes("$")) throw new SignerError(flag, value, "an unexpanded variable; type the name or let the shell expand it");
  if (/[<>[\]{}]/.test(v)) throw new SignerError(flag, value, "a placeholder, not a name");
  if (SIGNER_PLACEHOLDERS.includes(v.toLowerCase())) throw new SignerError(flag, value, "a role or placeholder, not a person");
  if (NOT_A_SIGNER.test(v)) throw new SignerError(flag, value, "names an agent, a default or an unanswered question; an owner act is signed by the owner");
  if (v.length < 2) throw new SignerError(flag, value, "too short to be a name");
  return v;
}

export class ExperimentRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentRefusal";
  }
}

export type SnapshotArg = { dataset: string; snapshotId: string };

/** `dataset=id[,dataset=id]`: the datasets the registration freezes, each naming an existing snapshot. */
export function parseSnapshotArg(raw: string | undefined): SnapshotArg[] {
  if (raw === undefined || raw.trim().length === 0) throw new ExperimentRefusal("--snapshot <dataset>=<snapshot id>[,...] is required: a registration freezes at least one snapshot");
  const out: SnapshotArg[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t.length === 0) continue;
    const i = t.indexOf("=");
    if (i <= 0 || i === t.length - 1) throw new ExperimentRefusal(`--snapshot: expected <dataset>=<snapshot id>, got "${t}"`);
    out.push({ dataset: t.slice(0, i).trim(), snapshotId: t.slice(i + 1).trim() });
  }
  if (out.length === 0) throw new ExperimentRefusal("--snapshot names no snapshot");
  const datasets = new Set(out.map((s) => s.dataset));
  if (datasets.size !== out.length) throw new ExperimentRefusal("--snapshot names a dataset twice");
  return out.sort((a, b) => a.dataset.localeCompare(b.dataset));
}

export function parseLabelsArg(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0))].sort();
}

/**
 * The charter -> experiment-definition mapping (docs/EXPERIMENT_PROTOCOL.md section 2.2). Every choice here is
 * frozen into `definition_hash`, so it is written down and never changed in place: a change is a new mapping
 * version and makes earlier registrations non-comparable.
 */
export function buildExperimentDefinition(input: {
  loaded: LoadedCharter;
  buildCommit: string;
  snapshots: readonly SnapshotArg[];
  coverageReportId?: string;
  processingDelayMs: number;
}): ExperimentDefinitionInput {
  const c = input.loaded.charter;
  const grid = enumerateGrid(c);
  const values = <T extends string | number>(pick: (p: (typeof grid.points)[number]) => T): T[] => [...new Set(grid.points.map(pick))];
  const tier = (t: Charter["costs"]["base"]): ExperimentDefinitionInput["costs"]["base"] => {
    const half = t.half_spread_bps["default"];
    if (half === undefined) throw new ExperimentRefusal("the charter's cost tier has no `default` half spread; the definition carries one half spread per tier");
    return { commission_bps: t.commission_bps, half_spread_bps: half, slippage_bps: t.slippage_bps, delay_bars: t.delay_bars };
  };
  const pf = c.pass_fail;
  return {
    charter: {
      strategy_id: c.strategy_id,
      charter_version: c.charter_version,
      charter_hash: input.loaded.charterHash,
      ...(c.approval.approval_ref === null ? {} : { owner_approval_ref: c.approval.approval_ref }),
    },
    code: { repo: REPO_SLUG, commit: input.buildCommit, dirty_tree_allowed: false },
    data: {
      snapshots: input.snapshots.map((s) => ({ dataset: s.dataset, snapshot_id: s.snapshotId })),
      ...(input.coverageReportId === undefined ? {} : { coverage_report_id: input.coverageReportId }),
      processing_delay_ms: input.processingDelayMs,
    },
    versions: { ...c.component_versions },
    arms: [...c.arms],
    search_space: {
      // One array per grid dimension (the registered point's dimensions), values distinct and in declaration
      // order. The Cartesian product is `enumerateGrid`; `trial_count` is its size, N for the deflated Sharpe.
      grid: {
        momentum_lookback_sessions: values((p) => p.momentumLookbackSessions),
        momentum_skip_sessions: values((p) => p.momentumSkipSessions),
        trend_sma_sessions: values((p) => p.trendSmaSessions),
        volatility_sessions: values((p) => p.volatilitySessions),
        entry_rank: values((p) => p.entryRank),
        hold_rank: values((p) => p.holdRank),
        annual_volatility_target: values((p) => p.annualVolatilityTarget.toFixed()),
        rebalance_band_pct_points: values((p) => p.rebalanceBandPctPoints.toFixed()),
      },
      sampling: "full_grid",
      trial_count: grid.trialCount,
    },
    boundaries: {
      // train = the design window; validation = the recent window (quasi-forward, reported separately).
      train: { start: c.boundaries.design.start, end: c.boundaries.design.end },
      validation: { start: c.boundaries.recent.start, end: c.boundaries.recent.end },
      walk_forward: { ...c.boundaries.walk_forward },
      holdout: { start: c.boundaries.holdout.start, end: c.boundaries.holdout.end, opened: false },
    },
    metrics: { primary: pf.primary_metric, secondary: ["max_drawdown_ratio_vs_primary_benchmark", "grid_sign_agreement"] },
    costs: {
      base: tier(c.costs.base),
      adverse: tier(c.costs.adverse),
      // The charter's stress tier is reached through the multipliers; it has no slot of its own here.
      stress_multipliers: [...c.costs.stress_multipliers],
      delay_sensitivity_bars: [...c.costs.delay_sensitivity_bars],
      missing_data_rates: [...c.costs.missing_data_rates],
    },
    benchmarks: {
      primary: c.benchmarks.primary,
      ...(c.benchmarks.exposure_matched ? { exposure_matched: { equity: c.benchmarks.primary, cash: c.benchmarks.cash } } : {}),
      secondary: [...c.benchmarks.secondary],
    },
    pass_fail: {
      primary_condition: `${pf.primary_metric} > ${pf.primary_threshold} with a ${pf.bootstrap_block_sessions}-session block bootstrap at confidence ${pf.bootstrap_confidence} excluding zero`,
      robustness_conditions: [
        `max drawdown at or below ${pf.max_drawdown_ratio} x the primary benchmark's`,
        `at least ${pf.min_grid_sign_agreement} of sensitivity-grid members agree in sign`,
        ...pf.falsifiers.map((f) => `${f.id}: ${f.condition}`),
      ],
      minimum_independent_decisions: pf.minimum_independent_decisions,
    },
    tax_scenarios: [...c.tax_scenarios],
  };
}

export type RegisterDeps = { db: Db; config: AppConfig; calendar: ExchangeCalendar; clock: () => number };

export type RegisterArgs = {
  charterPath: string;
  snapshots: readonly SnapshotArg[];
  registeredBy: string;
  labels?: readonly string[];
  requireCitable?: boolean;
  /** A written reason for a registration that is not the prospective clock's anchor (an evaluation-store child). */
  noShadowClock?: string;
  /** Where to write the registration-time coverage report (JSON). */
  coverageReportPath?: string;
  dryRun?: boolean;
  parentExperimentId?: string;
  supersedesReason?: string;
};

export type ShadowClockCheck = {
  /** Whether this process seals prospective decisions for a configured shadow charter. */
  seals: boolean;
  mode: AppConfig["mode"];
  shadowCharterPath: string | null;
  shadowCharterHash: string | null;
  /** True when a registration of `--charter` counts for the configured shadow charter's clock. */
  startsClock: boolean;
  noShadowClockReason: string | null;
};

/**
 * The clock guard. A registration starts the 26/52-week clock only when the process that will seal decisions
 * (SHADOW/PAPER with BLACKGOLD_SHADOW_CHARTER) seals for exactly this charter hash. Anything else is refused
 * unless the owner says, in writing, that this registration is not the clock's anchor.
 */
export function checkShadowClock(config: AppConfig, loaded: LoadedCharter, noShadowClock: string | undefined): ShadowClockCheck {
  const shadowPath = config.shadow.charterPath;
  const seals = sealsProspectiveDecisions(config.mode) && shadowPath !== undefined && shadowPath !== "";
  const reason = noShadowClock === undefined ? null : noShadowClock.trim();
  if (reason !== null && reason.length === 0) throw new ExperimentRefusal("--no-shadow-clock needs a written reason");
  if (!seals) {
    if (reason === null) {
      throw new ExperimentRefusal(
        `this process does not seal prospective decisions (mode ${config.mode}${shadowPath === undefined || shadowPath === "" ? ", no shadow charter configured" : ""}), so a registration here cannot start the 26/52-week clock (OD-10). ` +
          "Register from the sealing (SHADOW) process, or pass --no-shadow-clock <reason> for a registration that is not the clock's anchor",
      );
    }
    return { seals: false, mode: config.mode, shadowCharterPath: shadowPath ?? null, shadowCharterHash: null, startsClock: false, noShadowClockReason: reason };
  }
  const shadowHash = loadCharterFile(shadowPath).charterHash;
  if (shadowHash !== loaded.charterHash && reason === null) {
    throw new ExperimentRefusal(
      `--charter ${loaded.path} hashes to ${loaded.charterHash} but this process seals decisions for ${shadowPath} (${shadowHash}); ` +
        "a registration of a different charter would never start the clock. Register the configured charter, or pass --no-shadow-clock <reason>",
    );
  }
  return {
    seals: true,
    mode: config.mode,
    shadowCharterPath: shadowPath,
    shadowCharterHash: shadowHash,
    startsClock: shadowHash === loaded.charterHash && reason === null,
    noShadowClockReason: reason,
  };
}

export type RegisterOutput = {
  dryRun: boolean;
  experimentId: string | null;
  registeredAt: UtcInstant | null;
  registeredBy: string;
  strategyId: string;
  charterVersion: string;
  charterHash: string;
  definitionHash: string;
  buildCommit: string;
  snapshots: SnapshotArg[];
  labels: string[];
  promotionEvidenceAllowed: boolean;
  coverage: { reportId: string; from: IsoDate; to: IsoDate; snapshotId: string | undefined; uncovered: string[]; belowMinimum: string[]; promotionBlockingCodes: string[]; writtenTo: string | null };
  shadowClock: ShadowClockCheck;
  definition: ExperimentDefinitionInput;
};

/**
 * `experiment register`. Every refusal happens before anything is written; `dryRun` runs the same checks and the
 * registry's own preflight, prints what would be frozen, and writes nothing (not even the EXP-<year> counter).
 */
export function registerExperiment(deps: RegisterDeps, args: RegisterArgs): RegisterOutput {
  const registeredBy = validateSigner(args.registeredBy, "--registered-by");
  const buildCommit = deps.config.buildCommit;
  if (buildCommit === undefined) {
    throw new ExperimentRefusal(
      "BLACKGOLD_BUILD_COMMIT is not set: this executable does not know the commit it was built from, so it cannot freeze `code.commit`. " +
        "Register from a CI-built image (the Dockerfile bakes the commit); a local build cannot register",
    );
  }
  if (args.snapshots.length === 0) throw new ExperimentRefusal("--snapshot is required");

  const loaded = loadCharterFile(args.charterPath);
  assertRegistrable(loaded.charter);

  const pit = new PointInTimeRepository(deps.db, { clock: deps.clock, processingDelayOverrides: processingDelayOverridesMs(deps.config.sources) });
  for (const s of args.snapshots) {
    const snap = pit.snapshot(s.snapshotId); // throws UnknownSnapshotError
    if (snap.dataset !== s.dataset) throw new ExperimentRefusal(`--snapshot ${s.dataset}=${s.snapshotId}: that snapshot was taken for dataset "${snap.dataset}"`);
  }

  const shadowClock = checkShadowClock(deps.config, loaded, args.noShadowClock);

  // The registration-time coverage report, scoped to the frozen bars snapshot so it measures what the
  // experiment will read. Its id is frozen into the definition; its promotion-blocking codes become labels, so
  // a store carrying single-source corporate actions registers as honestly non-citable.
  const today = isoDate(nowUtc(deps.clock).slice(0, 10));
  const from = isoDate(loaded.charter.boundaries.registered_history_start);
  const recentEnd = isoDate(loaded.charter.boundaries.recent.end);
  const to = today < recentEnd ? today : recentEnd;
  const barsSnapshot = args.snapshots.find((s) => s.dataset === "prices_daily") ?? args.snapshots[0];
  const decisionAt = deps.calendar.sessionClose(deps.calendar.previousSession(utc(`${to}T23:59:59Z`)));
  const report: CoverageReport = buildCoverageReport({
    pit,
    calendar: deps.calendar,
    entities: charterUniverseMembers(loaded.charter),
    from,
    to,
    decisionAt,
    ...(barsSnapshot === undefined ? {} : { snapshotId: barsSnapshot.snapshotId }),
  });
  if (report.uncovered.length > 0) {
    throw new ExperimentRefusal(`coverage: ${report.uncovered.join(", ")} ${report.uncovered.length === 1 ? "has" : "have"} no bars in the snapshot between ${from} and ${to}; ingest before registering`);
  }
  if (args.requireCitable === true && report.promotionBlockingCodes.length > 0) {
    throw new ExperimentRefusal(
      `--require-citable: the store carries promotion-blocking data (${report.promotionBlockingCodes.join(", ")}); a registration here could never be cited. ` +
        "Register on a store built from reconciled sources (D-57(b)), or drop --require-citable to register a non-citable experiment",
    );
  }
  let writtenTo: string | null = null;
  if (args.coverageReportPath !== undefined) {
    writeFileSync(args.coverageReportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    writtenTo = args.coverageReportPath;
  }

  const labels = [...new Set([...(args.labels ?? []), ...report.promotionBlockingCodes, ...(shadowClock.noShadowClockReason === null ? [] : [NO_SHADOW_CLOCK_LABEL])])].sort();
  // The delay every asOf read in the run applies to the bars source (the charter's default source).
  const processingDelayMs = defaultProcessingDelayMs(DEFAULT_BARS_SOURCE_ID, processingDelayOverridesMs(deps.config.sources));
  const definition = buildExperimentDefinition({ loaded, buildCommit, snapshots: args.snapshots, coverageReportId: report.reportId, processingDelayMs });

  const ledger = new Ledger(deps.db, deps.clock);
  const registry = new ExperimentRegistry(deps.db, pit, ledger, { clock: deps.clock });
  const opts = {
    registeredBy,
    labels,
    ...(args.parentExperimentId === undefined ? {} : { parentExperimentId: args.parentExperimentId }),
    ...(args.supersedesReason === undefined ? {} : { supersedesReason: args.supersedesReason }),
  };
  const coverage = {
    reportId: report.reportId,
    from,
    to,
    snapshotId: report.snapshotId,
    uncovered: report.uncovered,
    belowMinimum: report.belowMinimum,
    promotionBlockingCodes: report.promotionBlockingCodes,
    writtenTo,
  };
  const base = { registeredBy, strategyId: loaded.charter.strategy_id, charterVersion: loaded.charter.charter_version, charterHash: loaded.charterHash, buildCommit, snapshots: [...args.snapshots], coverage, shadowClock, definition };

  if (args.dryRun === true) {
    const pf = registry.preflight(definition, opts);
    return { dryRun: true, experimentId: null, registeredAt: null, definitionHash: pf.definitionHash, labels: pf.labels, promotionEvidenceAllowed: pf.promotionEvidenceAllowed, ...base };
  }

  const rec = deps.db.transaction((): ExperimentRecord => {
    const r = registry.register(definition, opts);
    if (shadowClock.noShadowClockReason !== null) {
      ledger.append("experiment.no_shadow_clock", { experimentId: r.experimentId, charterHash: loaded.charterHash, mode: deps.config.mode, reason: shadowClock.noShadowClockReason }, r.registeredAt);
    }
    return r;
  });
  return { dryRun: false, experimentId: rec.experimentId, registeredAt: rec.registeredAt, definitionHash: rec.definitionHash, labels: rec.labels, promotionEvidenceAllowed: rec.promotionEvidenceAllowed, ...base };
}

export type ExperimentSummary = {
  experimentId: string;
  registeredAt: UtcInstant;
  registeredBy: string;
  strategyId: string;
  charterVersion: string;
  charterHash: string;
  definitionHash: string;
  codeCommit: string;
  labels: string[];
  promotionEvidenceAllowed: boolean;
  parentExperimentId: string | null;
  resultsViewedAt: UtcInstant | null;
  holdoutOpenedAt: UtcInstant | null;
};

export function summarize(r: ExperimentRecord): ExperimentSummary {
  return {
    experimentId: r.experimentId,
    registeredAt: r.registeredAt,
    registeredBy: r.registeredBy,
    strategyId: r.definition.charter.strategy_id,
    charterVersion: r.definition.charter.charter_version,
    charterHash: r.definition.charter.charter_hash,
    definitionHash: r.definitionHash,
    codeCommit: r.definition.code.commit,
    labels: r.labels,
    promotionEvidenceAllowed: r.promotionEvidenceAllowed,
    parentExperimentId: r.parentExperimentId,
    resultsViewedAt: r.resultsViewedAt,
    holdoutOpenedAt: r.holdoutOpenedAt,
  };
}

function registryFor(deps: RegisterDeps): ExperimentRegistry {
  const pit = new PointInTimeRepository(deps.db, { clock: deps.clock, processingDelayOverrides: processingDelayOverridesMs(deps.config.sources) });
  return new ExperimentRegistry(deps.db, pit, new Ledger(deps.db, deps.clock), { clock: deps.clock });
}

export function listExperiments(deps: RegisterDeps): ExperimentSummary[] {
  return registryFor(deps).list().map(summarize);
}

export function showExperiment(deps: RegisterDeps, experimentId: string): ExperimentRecord {
  return registryFor(deps).get(experimentId);
}

/** `experiment mark-viewed`: the owner's act that logs the first view of a result (docs/EXPERIMENT_PROTOCOL.md section 3). */
export function markExperimentViewed(deps: RegisterDeps, args: { experimentId: string; viewedBy: string }): ExperimentSummary {
  const viewedBy = validateSigner(args.viewedBy, "--viewed-by");
  return summarize(registryFor(deps).markResultsViewed(args.experimentId, { viewedBy }));
}

/** `experiment open-holdout`: once, after review, with a written reason (section 3.1). */
export function openExperimentHoldout(deps: RegisterDeps, args: { experimentId: string; reason: string | undefined; requestedBy: string }): ExperimentSummary {
  const requestedBy = validateSigner(args.requestedBy, "--requested-by");
  const reason = args.reason?.trim() ?? "";
  if (reason.length === 0) throw new ExperimentRefusal("--reason is required: the holdout opens once, with the written decision that opens it");
  return summarize(registryFor(deps).openHoldout(args.experimentId, { reason, requestedBy }));
}
