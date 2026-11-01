import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db } from "@blackgold/shared";
import { Ledger, NyseCalendar, PointInTimeRepository, openCoreDb } from "../src/index.ts";
import { loadAppConfig, parseAppConfig } from "../src/config/load.ts";
import type { AppConfig } from "../src/config/schema.ts";
import { UNVERIFIED_SINGLE_SOURCE } from "../src/data/adapters/corporate-actions.ts";
import { NO_SHADOW_CLOCK_LABEL } from "../src/decision/decision-record.ts";
import { CharterNotRegistrableError, loadCharterFile } from "../src/strategy/charter.ts";
import { enumerateGrid } from "../src/research/robustness.ts";
import { UnknownSnapshotError } from "../src/data/pit/repository.ts";
import { ExperimentDefinitionSchema, HoldoutBeforeReviewError, definitionHash } from "../src/research/registry.ts";
import {
  buildExperimentDefinition,
  ExperimentRefusal,
  listExperiments,
  markExperimentViewed,
  openExperimentHoldout,
  parseLabelsArg,
  parseSnapshotArg,
  registerExperiment,
  showExperiment,
  SignerError,
  validateSigner,
  type RegisterDeps,
} from "../src/research/experiment-cli.ts";
import { buildMarket, D, N, type PricePath } from "./strategy-fixture.ts";
import { writeShadowCharter } from "./charter-file-fixture.ts";

/**
 * The owner's `experiment` CLI (B1). Every refusal is tested as the refusal the owner would see; the happy path
 * freezes exactly what the registry stores; nothing is written by a dry run.
 */

const cal = new NyseCalendar();
const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const PATHS: PricePath[] = [
  { entityId: "VTI", start: N("200"), perSession: N("1.0010"), volumeShares: 4_000_000n, wobble: N("0.003") },
  { entityId: "QQQ", start: N("400"), perSession: N("1.0018"), volumeShares: 5_000_000n, wobble: N("0.005") },
  { entityId: "IWM", start: N("180"), perSession: N("1.0006"), volumeShares: 3_000_000n, wobble: N("0.004") },
  { entityId: "VTV", start: N("150"), perSession: N("1.0004"), volumeShares: 2_000_000n, wobble: N("0.002") },
  { entityId: "VUG", start: N("300"), perSession: N("1.0014"), volumeShares: 3_500_000n, wobble: N("0.004") },
  { entityId: "XLK", start: N("200"), perSession: N("1.0016"), volumeShares: 4_500_000n, wobble: N("0.005") },
  { entityId: "XLV", start: N("140"), perSession: N("1.0008"), volumeShares: 2_500_000n, wobble: N("0.003") },
  { entityId: "XLU", start: N("70"), perSession: N("0.9994"), volumeShares: 2_000_000n, wobble: N("0.002") },
  { entityId: "BIL", start: N("91"), perSession: N("1.00008"), volumeShares: 900_000n },
  { entityId: "SPY", start: N("500"), perSession: N("1.0010"), volumeShares: 6_000_000n, wobble: N("0.003") },
];

type Env = { dir: string; db: Db; config: AppConfig; charterPath: string; snapshotId: string; deps: RegisterDeps; ledgerCount: () => number; experiments: () => number };

function setup(opts: { mode?: "SHADOW" | "RESEARCH"; shadowCharter?: boolean; buildCommit?: string | null; omit?: string[]; singleSource?: boolean; edit?: (doc: Record<string, unknown>) => void } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "bg-expcli-"));
  const db = openCoreDb({ dbPath: join(dir, "s.sqlite") }).db;
  const omit = new Set(opts.omit ?? []);
  buildMarket({
    paths: PATHS.filter((p) => !omit.has(p.entityId)),
    from: D("2026-01-02"),
    to: D("2026-03-13"),
    db,
    ...(opts.singleSource === true
      ? { actions: [{ action: { kind: "CASH_DIVIDEND" as const, entityId: "VTI", amount: N("0.50"), exDate: D("2026-02-10"), payDate: D("2026-02-10"), qualified: false }, qualityFlags: [UNVERIFIED_SINGLE_SOURCE] }] }
      : {}),
  });
  const charterPath = writeShadowCharter(dir, opts.edit === undefined ? {} : { edit: opts.edit });
  let now = Date.parse("2026-03-10T12:00:00Z");
  const clock = (): number => (now += 1000);
  const snapshotId = new PointInTimeRepository(db, { clock }).createSnapshot("prices_daily", "test").snapshotId;
  const config = parseAppConfig({
    mode: opts.mode ?? "SHADOW",
    ...(opts.buildCommit === null ? {} : { buildCommit: opts.buildCommit ?? BUILD_COMMIT }),
    shadow: { ...(opts.shadowCharter === false ? {} : { charterPath }), policyDir: dir },
  });
  const deps: RegisterDeps = { db, config, calendar: cal, clock };
  return {
    dir,
    db,
    config,
    charterPath,
    snapshotId,
    deps,
    ledgerCount: () => new Ledger(db).count(),
    experiments: () => (db.prepare("SELECT COUNT(*) AS n FROM experiments").get() as { n: number }).n,
  };
}

const args = (env: Env, over: Partial<Parameters<typeof registerExperiment>[1]> = {}): Parameters<typeof registerExperiment>[1] => ({
  charterPath: env.charterPath,
  snapshots: [{ dataset: "prices_daily", snapshotId: env.snapshotId }],
  registeredBy: "Ada Lovelace",
  ...over,
});

describe("validateSigner", () => {
  it("refuses placeholder signers: blanks, roles, agents, defaults, unexpanded variables, angle brackets", () => {
    for (const v of [undefined, "", "   ", "owner", "Owner", "the owner", "TODO", "tbd", "test", "Claude", "Claude Code", "claude-code", "Anthropic", "Codex", "default", "silence", "$BLACKGOLD_SIGNER", "<name>", "Matt Herman (default)", "example", "x"]) {
      expect(() => validateSigner(v, "--registered-by"), String(v)).toThrow(SignerError);
    }
  });

  it("accepts a typed name, trimmed", () => {
    expect(validateSigner("  Matt Herman ", "--registered-by")).toBe("Matt Herman");
    expect(validateSigner("J. Doe", "--viewed-by")).toBe("J. Doe");
  });
});

describe("flag parsing", () => {
  it("parses dataset=id lists, sorted, refusing malformed and duplicate entries", () => {
    expect(parseSnapshotArg("prices_daily=snap_a, universe=snap_b")).toEqual([
      { dataset: "prices_daily", snapshotId: "snap_a" },
      { dataset: "universe", snapshotId: "snap_b" },
    ]);
    for (const bad of [undefined, "", "snap_a", "=snap_a", "prices_daily=", "a=1,a=2"]) expect(() => parseSnapshotArg(bad), String(bad)).toThrow(ExperimentRefusal);
    expect(parseLabelsArg(undefined)).toEqual([]);
    expect(parseLabelsArg("b, a,,a")).toEqual(["a", "b"]);
  });
});

describe("buildExperimentDefinition", () => {
  it("builds a strict, deterministic definition from the charter: grid size, cost tiers, benchmarks, versions, approval ref", () => {
    const env = setup();
    const loaded = loadCharterFile(env.charterPath);
    const input = { loaded, buildCommit: BUILD_COMMIT, snapshots: [{ dataset: "prices_daily", snapshotId: env.snapshotId }], coverageReportId: "cov_x", processingDelayMs: 900_000 };
    const def = ExperimentDefinitionSchema.parse(buildExperimentDefinition(input));
    expect(definitionHash(def)).toBe(definitionHash(ExperimentDefinitionSchema.parse(buildExperimentDefinition(input))));
    expect(def.search_space.trial_count).toBe(enumerateGrid(loaded.charter).trialCount);
    expect(def.search_space.sampling).toBe("full_grid");
    expect(def.charter).toEqual({ strategy_id: "etf-trend-vol", charter_version: loaded.charter.charter_version, charter_hash: loaded.charterHash, owner_approval_ref: loaded.charter.approval.approval_ref });
    expect(def.code).toEqual({ repo: "mherman1990/BlackGold", commit: BUILD_COMMIT, dirty_tree_allowed: false });
    expect(def.costs.base.half_spread_bps).toBe(loaded.charter.costs.base.half_spread_bps["default"]);
    expect(def.costs.adverse.delay_bars).toBe(loaded.charter.costs.adverse.delay_bars);
    expect(def.benchmarks).toEqual({ primary: "VTI", exposure_matched: { equity: "VTI", cash: "BIL" }, secondary: ["SPY"] });
    expect(def.versions).toEqual(loaded.charter.component_versions);
    expect(def.boundaries.train).toEqual(loaded.charter.boundaries.design);
    expect(def.boundaries.validation).toEqual(loaded.charter.boundaries.recent);
    expect(def.boundaries.holdout).toEqual({ ...loaded.charter.boundaries.holdout, opened: false });
    expect(def.data).toEqual({ snapshots: [{ dataset: "prices_daily", snapshot_id: env.snapshotId }], coverage_report_id: "cov_x", processing_delay_ms: 900_000 });
    expect(def.pass_fail.robustness_conditions.some((c) => c.startsWith("F2:"))).toBe(true);
  });
});

describe("registerExperiment refusals", () => {
  it("refuses to register without a baked build commit, and writes nothing", () => {
    const env = setup({ buildCommit: null });
    expect(() => registerExperiment(env.deps, args(env))).toThrow(/BLACKGOLD_BUILD_COMMIT/);
    expect(env.experiments()).toBe(0);
  });

  it("an image built without BLACKGOLD_BUILD_COMMIT (empty env value) has no build commit, so the config path fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-expcli-env-"));
    expect(loadAppConfig({ BLACKGOLD_DATA_DIR: dir, BLACKGOLD_BUILD_COMMIT: "" }).buildCommit).toBeUndefined();
    expect(loadAppConfig({ BLACKGOLD_DATA_DIR: dir }).buildCommit).toBeUndefined();
    expect(loadAppConfig({ BLACKGOLD_DATA_DIR: dir, BLACKGOLD_BUILD_COMMIT: BUILD_COMMIT }).buildCommit).toBe(BUILD_COMMIT);
    expect(() => loadAppConfig({ BLACKGOLD_DATA_DIR: dir, BLACKGOLD_BUILD_COMMIT: "not-a-sha" })).toThrow();
  });

  it("refuses placeholder signers before touching the store", () => {
    const env = setup();
    for (const registeredBy of ["owner", "Claude Code", "TODO", "$BLACKGOLD_SIGNER"]) {
      expect(() => registerExperiment(env.deps, args(env, { registeredBy })), registeredBy).toThrow(SignerError);
    }
    expect(env.experiments()).toBe(0);
  });

  it("refuses a charter that is not registrable (a DRAFT approval block)", () => {
    const env = setup({ edit: (doc) => Object.assign(doc["approval"] as Record<string, unknown>, { state: "DRAFT", approved_by: null, approval_date: null }) });
    expect(() => registerExperiment(env.deps, args(env))).toThrow(CharterNotRegistrableError);
  });

  it("refuses an unknown snapshot and a snapshot taken for another dataset", () => {
    const env = setup();
    expect(() => registerExperiment(env.deps, args(env, { snapshots: [{ dataset: "prices_daily", snapshotId: "snap_nope" }] }))).toThrow(UnknownSnapshotError);
    expect(() => registerExperiment(env.deps, args(env, { snapshots: [{ dataset: "universe", snapshotId: env.snapshotId }] }))).toThrow(/dataset/);
  });

  it("refuses to register from a process that does not seal (RESEARCH, or no shadow charter) unless --no-shadow-clock says why", () => {
    for (const env of [setup({ mode: "RESEARCH" }), setup({ mode: "SHADOW", shadowCharter: false })]) {
      expect(() => registerExperiment(env.deps, args(env))).toThrow(/cannot start the 26\/52-week clock/);
      expect(() => registerExperiment(env.deps, args(env, { noShadowClock: "   " }))).toThrow(/written reason/);
      expect(env.experiments()).toBe(0);
      const out = registerExperiment(env.deps, args(env, { noShadowClock: "evaluation-store child; clock anchored at the research-store registration" }));
      expect(out.shadowClock).toMatchObject({ seals: false, startsClock: false, noShadowClockReason: "evaluation-store child; clock anchored at the research-store registration" });
      expect(out.labels).toContain(NO_SHADOW_CLOCK_LABEL);
      expect(env.db.prepare("SELECT payload FROM ledger_events WHERE kind = 'experiment.no_shadow_clock'").all()).toHaveLength(1);
    }
  });

  it("refuses a charter other than the configured shadow charter: a registration of it would never start the clock", () => {
    const env = setup();
    const other = writeShadowCharter(env.dir, { fileName: "other.yaml", decisionOffsetMinutes: 90 });
    expect(loadCharterFile(other).charterHash).not.toBe(loadCharterFile(env.charterPath).charterHash);
    expect(() => registerExperiment(env.deps, args(env, { charterPath: other }))).toThrow(/would never start the clock/);
    const out = registerExperiment(env.deps, args(env, { charterPath: other, noShadowClock: "rehearsal" }));
    expect(out.shadowClock).toMatchObject({ seals: true, startsClock: false, shadowCharterHash: loadCharterFile(env.charterPath).charterHash });
  });

  it("--require-citable refuses a store with a single-source action; without it the registration carries the blocking label honestly", () => {
    const env = setup({ singleSource: true });
    expect(() => registerExperiment(env.deps, args(env, { requireCitable: true }))).toThrow(/UNVERIFIED_SINGLE_SOURCE/);
    expect(env.experiments()).toBe(0);
    const out = registerExperiment(env.deps, args(env));
    expect(out.coverage.promotionBlockingCodes).toEqual([UNVERIFIED_SINGLE_SOURCE]);
    expect(out.labels).toEqual([UNVERIFIED_SINGLE_SOURCE]);
    expect(out.promotionEvidenceAllowed).toBe(false);
    expect(showExperiment(env.deps, out.experimentId ?? "").promotionEvidenceAllowed).toBe(false);
  });

  it("refuses a store where a universe member has no bars at all", () => {
    const env = setup({ omit: ["XLU"] });
    expect(() => registerExperiment(env.deps, args(env))).toThrow(/XLU .*no bars/);
  });
});

describe("registerExperiment", () => {
  it("--dry-run runs every check, reports the hash the registration will carry, and writes nothing", () => {
    const env = setup();
    const before = env.ledgerCount();
    const dry = registerExperiment(env.deps, args(env, { dryRun: true }));
    expect(dry.dryRun).toBe(true);
    expect(dry.experimentId).toBeNull();
    expect(dry.shadowClock).toMatchObject({ seals: true, startsClock: true });
    expect(env.experiments()).toBe(0);
    expect(env.ledgerCount()).toBe(before);
    const real = registerExperiment(env.deps, args(env));
    expect(real.dryRun).toBe(false);
    expect(real.experimentId).toBe("EXP-2026-0001");
    expect(real.definitionHash).toBe(dry.definitionHash);
    expect(real.labels).toEqual([]);
    expect(real.promotionEvidenceAllowed).toBe(true);
    expect(real.buildCommit).toBe(BUILD_COMMIT);
    expect(real.coverage.reportId).toMatch(/^cov_\d{8}_[0-9a-f]{8}$/);
    expect(real.definition.data.coverage_report_id).toBe(real.coverage.reportId);
    expect(env.ledgerCount()).toBe(before + 1);
    const rec = showExperiment(env.deps, "EXP-2026-0001");
    expect(rec.registeredBy).toBe("Ada Lovelace");
    expect(rec.definition.code.commit).toBe(BUILD_COMMIT);
    expect(rec.definition.charter.charter_hash).toBe(loadCharterFile(env.charterPath).charterHash);
  });

  it("writes the coverage report where asked and never overwrites one", () => {
    const env = setup();
    const path = join(env.dir, "coverage.json");
    const out = registerExperiment(env.deps, args(env, { dryRun: true, coverageReportPath: path }));
    expect(existsSync(path)).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as { reportId: string; snapshotId: string }).reportId).toBe(out.coverage.reportId);
    expect((JSON.parse(readFileSync(path, "utf8")) as { snapshotId: string }).snapshotId).toBe(env.snapshotId);
    expect(() => registerExperiment(env.deps, args(env, { dryRun: true, coverageReportPath: path }))).toThrow(/EEXIST/);
  });

  it("list, show, mark-viewed and open-holdout: the owner's acts, each signed, in order, once", () => {
    const env = setup();
    expect(listExperiments(env.deps)).toEqual([]);
    const id = registerExperiment(env.deps, args(env)).experimentId ?? "";
    expect(listExperiments(env.deps).map((s) => [s.experimentId, s.resultsViewedAt, s.holdoutOpenedAt])).toEqual([[id, null, null]]);
    expect(() => openExperimentHoldout(env.deps, { experimentId: id, reason: "reviewed", requestedBy: "Ada Lovelace" })).toThrow(HoldoutBeforeReviewError);
    expect(() => markExperimentViewed(env.deps, { experimentId: id, viewedBy: "owner" })).toThrow(SignerError);
    const viewed = markExperimentViewed(env.deps, { experimentId: id, viewedBy: "Ada Lovelace" });
    expect(viewed.resultsViewedAt).not.toBeNull();
    expect(() => openExperimentHoldout(env.deps, { experimentId: id, reason: "  ", requestedBy: "Ada Lovelace" })).toThrow(/reason/);
    expect(() => openExperimentHoldout(env.deps, { experimentId: id, reason: "reviewed the design and walk-forward results", requestedBy: "Claude Code" })).toThrow(SignerError);
    const opened = openExperimentHoldout(env.deps, { experimentId: id, reason: "reviewed the design and walk-forward results", requestedBy: "Ada Lovelace" });
    expect(opened.holdoutOpenedAt).not.toBeNull();
    expect(env.db.prepare("SELECT kind FROM ledger_events ORDER BY seq").all()).toEqual(expect.arrayContaining([{ kind: "experiment.registered" }, { kind: "experiment.results_viewed" }, { kind: "experiment.holdout_opened" }]));
  });
});
