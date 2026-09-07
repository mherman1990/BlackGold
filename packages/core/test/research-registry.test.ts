import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, utc, type Db } from "@blackgold/shared";
import {
  DirtyTreeError,
  ExperimentRegistry,
  FrozenInputMismatchError,
  HoldoutAlreadyOpenedError,
  HoldoutBeforeReviewError,
  HoldoutInheritanceError,
  InvalidExperimentDefinitionError,
  Ledger,
  ParentRequiredError,
  PointInTimeRepository,
  PromotionEvidenceRefusedError,
  UnknownExperimentError,
  UnknownSnapshotError,
  openCoreDb,
  type ExperimentDefinitionInput,
} from "../src/index.ts";

const T0 = "2026-09-08T14:00:00Z";
const SHA = `sha256:${sha256Hex("x")}`;

function setup(): { db: Db; reg: ExperimentRegistry; ledger: Ledger; snapshotId: string; pit: PointInTimeRepository } {
  const dir = mkdtempSync(join(tmpdir(), "bg-registry-"));
  const db = openCoreDb({ dbPath: join(dir, "r.sqlite") }).db;
  let now = Date.parse(T0);
  const clock = (): number => (now += 1000);
  const pit = new PointInTimeRepository(db, { clock });
  const ledger = new Ledger(db, clock);
  const snapshotId = pit.createSnapshot("prices_daily", "test").snapshotId;
  return { db, reg: new ExperimentRegistry(db, pit, ledger, { clock }), ledger, snapshotId, pit };
}

function def(snapshotId: string, over: Partial<ExperimentDefinitionInput> = {}): ExperimentDefinitionInput {
  return {
    charter: { strategy_id: "etf-trend-vol", charter_version: "0.1.0", charter_hash: SHA },
    code: { repo: "mherman1990/BlackGold", commit: "4f7a2c9e1b0d" },
    data: { snapshots: [{ dataset: "prices_daily", snapshot_id: snapshotId }], processing_delay_ms: 15 * 60_000 },
    versions: { features: 1, strategy_rules: 1, portfolio_construction: 1, risk_policy: 1, cost_model: 1 },
    arms: ["B0_PASSIVE", "B1_DETERMINISTIC"],
    search_space: { grid: { lookback_days: [126, 252] }, sampling: "full_grid", trial_count: 2 },
    boundaries: {
      train: { start: "2008-01-02", end: "2016-12-30" },
      validation: { start: "2017-01-03", end: "2019-12-31" },
      walk_forward: { window_years: 3, step_months: 12, purge_days: 21, embargo_days: 5 },
      holdout: { start: "2020-01-02", end: "2025-12-31", opened: false },
    },
    metrics: { primary: "net_information_ratio_vs_primary_benchmark", secondary: ["max_drawdown"] },
    costs: {
      base: { commission_bps: "0", half_spread_bps: "2", slippage_bps: "3", delay_bars: 1 },
      adverse: { commission_bps: "0", half_spread_bps: "5", slippage_bps: "8", delay_bars: 1 },
      stress_multipliers: ["1.0", "2.0"],
      delay_sensitivity_bars: [0, 1, 2],
      missing_data_rates: ["0.00", "0.02"],
    },
    benchmarks: { primary: "VTI_TR", exposure_matched: { equity: "VTI_TR", cash: "BIL_TR" }, secondary: ["SPY_TR"] },
    pass_fail: { primary_condition: "B1 minus B0 net IR > 0.10", robustness_conditions: ["sign unchanged under 2x costs"], minimum_independent_decisions: 60 },
    tax_scenarios: ["pre_tax", "taxable_short_long_split"],
    ...over,
  };
}

describe("ExperimentRegistry.register", () => {
  it("assigns EXP-<year>-<seq>, hashes the definition, and logs a ledger event", () => {
    const { reg, ledger, snapshotId } = setup();
    const a = reg.register(def(snapshotId), { registeredBy: "owner" });
    expect(a.experimentId).toBe("EXP-2026-0001");
    expect(a.definitionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.labels).toEqual([]);
    expect(a.promotionEvidenceAllowed).toBe(true);
    expect(a.resultsViewedAt).toBeNull();
    expect(a.definition.code.dirty_tree_allowed).toBe(false);
    const b = reg.register(def(snapshotId, { charter: { strategy_id: "other", charter_version: "1.0.0", charter_hash: SHA } }), { registeredBy: "owner" });
    expect(b.experimentId).toBe("EXP-2026-0002");
    const events = ledger.events().filter((e) => e.kind === "experiment.registered");
    expect(events).toHaveLength(2);
    expect((events[0]?.payload as { experimentId: string; snapshotIds: string[] }).snapshotIds).toEqual([snapshotId]);
    expect(reg.list().map((r) => r.experimentId)).toEqual(["EXP-2026-0001", "EXP-2026-0002"]);
    expect(() => reg.get("EXP-2026-0009")).toThrow(UnknownExperimentError);
  });

  it("refuses unknown snapshots, dirty trees, and malformed definitions before writing", () => {
    const { reg, snapshotId, ledger } = setup();
    expect(() => reg.register(def("snap_missing"), { registeredBy: "owner" })).toThrow(UnknownSnapshotError);
    expect(() => reg.register(def(snapshotId, { code: { repo: "r", commit: "4f7a2c9e1b0d", dirty_tree_allowed: true } }), { registeredBy: "owner" })).toThrow(DirtyTreeError);
    expect(() => reg.register(def(snapshotId, { code: { repo: "r", commit: "not-hex" } }), { registeredBy: "owner" })).toThrow(InvalidExperimentDefinitionError);
    expect(() => reg.register({ ...def(snapshotId), extra: 1 } as unknown as ExperimentDefinitionInput, { registeredBy: "owner" })).toThrow(InvalidExperimentDefinitionError);
    expect(() =>
      reg.register(def(snapshotId, { costs: { ...def(snapshotId).costs, base: { commission_bps: "0.5e1", half_spread_bps: "2", slippage_bps: "3", delay_bars: 1 } } }), { registeredBy: "owner" }),
    ).toThrow(InvalidExperimentDefinitionError);
    expect(reg.list()).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it("after results are viewed, a same-charter registration must name a parent", () => {
    const { reg, ledger, snapshotId } = setup();
    const a = reg.register(def(snapshotId), { registeredBy: "owner" });
    const viewed = reg.markResultsViewed(a.experimentId, { viewedBy: "owner" });
    expect(viewed.resultsViewedAt).not.toBeNull();
    const again = reg.markResultsViewed(a.experimentId, { viewedBy: "owner" });
    expect(again.resultsViewedAt).toBe(viewed.resultsViewedAt); // idempotent, no second event
    expect(ledger.events().filter((e) => e.kind === "experiment.results_viewed")).toHaveLength(1);
    expect(() => reg.register(def(snapshotId), { registeredBy: "owner" })).toThrow(ParentRequiredError);
    const child = reg.register(def(snapshotId), { registeredBy: "owner", parentExperimentId: a.experimentId, supersedesReason: "widened grid after viewing" });
    expect(child.parentExperimentId).toBe(a.experimentId);
    expect(child.supersedesReason).toBe("widened grid after viewing");
    // A different charter is a fresh hypothesis and needs no parent.
    expect(() => reg.register(def(snapshotId, { charter: { strategy_id: "fresh", charter_version: "1.0.0", charter_hash: SHA } }), { registeredBy: "owner" })).not.toThrow();
    expect(() => reg.register(def(snapshotId), { registeredBy: "owner", parentExperimentId: "EXP-1999-0001" })).toThrow(UnknownExperimentError);
  });
});

describe("ExperimentRegistry holdout", () => {
  it("opens once, only after review, with a reason logged to the ledger", () => {
    const { reg, ledger, snapshotId } = setup();
    const a = reg.register(def(snapshotId), { registeredBy: "owner" });
    expect(() => reg.openHoldout(a.experimentId, { reason: "curious", requestedBy: "owner" })).toThrow(HoldoutBeforeReviewError);
    reg.markResultsViewed(a.experimentId, { viewedBy: "owner" });
    expect(() => reg.openHoldout(a.experimentId, { reason: "   ", requestedBy: "owner" })).toThrow(TypeError);
    const opened = reg.openHoldout(a.experimentId, { reason: "validation and walk-forward reviewed; decision memo 2026-09-08", requestedBy: "owner" });
    expect(opened.holdoutOpenedAt).not.toBeNull();
    expect(opened.holdoutOpenedBy).toBe("owner");
    expect(() => reg.openHoldout(a.experimentId, { reason: "again", requestedBy: "owner" })).toThrow(HoldoutAlreadyOpenedError);
    const ev = ledger.events().find((e) => e.kind === "experiment.holdout_opened");
    expect((ev?.payload as { reason: string; holdout: { start: string } }).reason).toMatch(/decision memo/);
    expect((ev?.payload as { holdout: { start: string } }).holdout.start).toBe("2020-01-02");
    expect(ledger.verifyChain()).toEqual({ ok: true });
  });

  it("a descendant of an opened holdout must declare a later holdout or state none remains", () => {
    const { reg, snapshotId } = setup();
    const a = reg.register(def(snapshotId), { registeredBy: "owner" });
    reg.markResultsViewed(a.experimentId, { viewedBy: "owner" });
    reg.openHoldout(a.experimentId, { reason: "reviewed", requestedBy: "owner" });
    expect(() => reg.register(def(snapshotId), { registeredBy: "owner", parentExperimentId: a.experimentId })).toThrow(HoldoutInheritanceError);
    const base = def(snapshotId);
    const later = reg.register(
      { ...base, boundaries: { ...base.boundaries, holdout: { start: "2026-01-02", end: "2026-12-31", opened: false } } },
      { registeredBy: "owner", parentExperimentId: a.experimentId },
    );
    expect(later.experimentId).toBe("EXP-2026-0002");
    const none = reg.register(
      { ...base, boundaries: { ...base.boundaries, holdout: { ...base.boundaries.holdout, opened: true } } },
      { registeredBy: "owner", parentExperimentId: a.experimentId },
    );
    expect(none.definition.boundaries.holdout.opened).toBe(true);
  });
});

describe("ExperimentRegistry promotion evidence", () => {
  it("refuses SURVIVORSHIP_BIASED and OPTIMISTIC_DELAY runs and runs whose holdout never opened", () => {
    const { reg, snapshotId } = setup();
    const biased = reg.register(def(snapshotId), { registeredBy: "owner", labels: ["SURVIVORSHIP_BIASED"] });
    expect(biased.promotionEvidenceAllowed).toBe(false);
    reg.markResultsViewed(biased.experimentId, { viewedBy: "owner" });
    reg.openHoldout(biased.experimentId, { reason: "reviewed", requestedBy: "owner" });
    expect(() => reg.setPromotionEvidence(biased.experimentId, true, { requestedBy: "owner" })).toThrow(PromotionEvidenceRefusedError);

    const zeroDelay = reg.register(
      def(snapshotId, {
        charter: { strategy_id: "zero-delay", charter_version: "1.0.0", charter_hash: SHA },
        data: { snapshots: [{ dataset: "prices_daily", snapshot_id: snapshotId }], processing_delay_ms: 0 },
      }),
      { registeredBy: "owner" },
    );
    expect(zeroDelay.labels).toEqual(["OPTIMISTIC_DELAY"]);
    expect(zeroDelay.promotionEvidenceAllowed).toBe(false);

    const clean = reg.register(def(snapshotId, { charter: { strategy_id: "clean", charter_version: "1.0.0", charter_hash: SHA } }), { registeredBy: "owner" });
    expect(() => reg.setPromotionEvidence(clean.experimentId, true, { requestedBy: "owner" })).toThrow(/holdout was never opened/);
    reg.markResultsViewed(clean.experimentId, { viewedBy: "owner" });
    reg.openHoldout(clean.experimentId, { reason: "reviewed", requestedBy: "owner" });
    const cited = reg.setPromotionEvidence(clean.experimentId, true, { requestedBy: "owner" });
    expect(cited.promotionEvidenceAt).not.toBeNull();
    expect(cited.promotionEvidenceBy).toBe("owner");
    const withdrawn = reg.setPromotionEvidence(clean.experimentId, false, { requestedBy: "owner" });
    expect(withdrawn.promotionEvidenceAt).toBeNull();
  });
});

describe("ExperimentRegistry trial ledger", () => {
  const trial = (experimentId: string, snapshotId: string, over: Record<string, unknown> = {}) => ({
    experimentId,
    arm: "B1_DETERMINISTIC",
    split: "validation/2017-01-03_2019-12-31",
    params: { lookback_days: 126 },
    metrics: { primary_metric: "0.31", max_drawdown: "-0.187" },
    costScenario: "base",
    codeCommit: "4f7a2c9e1b0d",
    snapshotIds: [snapshotId],
    resultHash: SHA,
    runStarted: utc("2026-09-08T15:01:44Z"),
    runFinished: utc("2026-09-08T15:03:10Z"),
    ...over,
  });

  it("appends rows with sequential ids, inherits experiment labels, and refuses frozen-input mismatches", () => {
    const { reg, snapshotId, ledger } = setup();
    const a = reg.register(def(snapshotId), { registeredBy: "owner", labels: ["SURVIVORSHIP_BIASED"] });
    const t1 = reg.recordTrial(trial(a.experimentId, snapshotId));
    expect(t1.trialId).toBe(`${a.experimentId}/t-001`);
    expect(t1.labels).toEqual(["SURVIVORSHIP_BIASED"]);
    const t2 = reg.recordTrial(trial(a.experimentId, snapshotId, { labels: ["HISTORICAL_REPLAY_CONTAMINATED"] }));
    expect(t2.trialId).toBe(`${a.experimentId}/t-002`);
    expect(t2.labels).toEqual(["HISTORICAL_REPLAY_CONTAMINATED", "SURVIVORSHIP_BIASED"]);
    expect(reg.trials(a.experimentId).map((t) => t.trialId)).toEqual([t1.trialId, t2.trialId]);
    expect(reg.trials(a.experimentId)[0]?.metrics).toEqual({ primary_metric: "0.31", max_drawdown: "-0.187" });
    expect(() => reg.recordTrial(trial(a.experimentId, snapshotId, { codeCommit: "deadbeef" }))).toThrow(FrozenInputMismatchError);
    expect(() => reg.recordTrial(trial(a.experimentId, snapshotId, { codeCommit: "zz" }))).toThrow(TypeError);
    expect(() => reg.recordTrial(trial(a.experimentId, snapshotId, { snapshotIds: ["snap_other"] }))).toThrow(FrozenInputMismatchError);
    expect(() => reg.recordTrial(trial(a.experimentId, snapshotId, { arm: "C1_LLM_OVERLAY" }))).toThrow(FrozenInputMismatchError);
    expect(() => reg.recordTrial(trial(a.experimentId, snapshotId, { resultHash: "sha256:short" }))).toThrow(TypeError);
    expect(() => reg.recordTrial(trial("EXP-2026-0099", snapshotId))).toThrow(UnknownExperimentError);
    expect(ledger.events().filter((e) => e.kind === "experiment.trial_recorded")).toHaveLength(2);
  });

  it("is append-only at the database level and the experiment definition is frozen", () => {
    const { db, reg, snapshotId } = setup();
    const a = reg.register(def(snapshotId), { registeredBy: "owner" });
    reg.recordTrial(trial(a.experimentId, snapshotId));
    expect(() => {
      db.exec("UPDATE trial_ledger SET metrics_json = '{}'");
    }).toThrow(/append-only/);
    expect(() => {
      db.exec("DELETE FROM trial_ledger");
    }).toThrow(/append-only/);
    expect(() => {
      db.exec("UPDATE experiments SET definition_json = '{}', definition_hash = 'sha256:00'");
    }).toThrow(/frozen/);
    expect(() => {
      db.exec("UPDATE experiments SET labels_json = '[\"SURVIVORSHIP_BIASED\"]'");
    }).toThrow(/frozen/);
    expect(() => {
      db.exec("DELETE FROM experiments");
    }).toThrow(/never deleted/);
    // Once viewed, the view timestamp cannot be moved even by raw SQL.
    reg.markResultsViewed(a.experimentId, { viewedBy: "owner" });
    expect(() => {
      db.exec("UPDATE experiments SET results_viewed_at = '2030-01-01T00:00:00.000Z'");
    }).toThrow(/set once/);
  });

  it("cumulative trial count walks the parent chain", () => {
    const { reg, snapshotId } = setup();
    const a = reg.register(def(snapshotId), { registeredBy: "owner" });
    reg.recordTrial(trial(a.experimentId, snapshotId));
    reg.recordTrial(trial(a.experimentId, snapshotId));
    reg.markResultsViewed(a.experimentId, { viewedBy: "owner" });
    const b = reg.register(def(snapshotId), { registeredBy: "owner", parentExperimentId: a.experimentId });
    reg.recordTrial(trial(b.experimentId, snapshotId));
    const c = reg.register(def(snapshotId), { registeredBy: "owner", parentExperimentId: b.experimentId });
    expect(reg.cumulativeTrialCount(a.experimentId)).toBe(2);
    expect(reg.cumulativeTrialCount(b.experimentId)).toBe(3);
    expect(reg.cumulativeTrialCount(c.experimentId)).toBe(3);
  });
});

describe("ExperimentRegistry promotion evidence with trial labels", () => {
  it("refuses promotion when any recorded trial carries a blocking label, even if the registration was clean", () => {
    const { reg, snapshotId } = setup();
    const clean = reg.register(def(snapshotId), { registeredBy: "owner" });
    expect(clean.promotionEvidenceAllowed).toBe(true);
    const base = {
      experimentId: clean.experimentId,
      arm: "B1_DETERMINISTIC",
      split: "validation/2017-01-03_2019-12-31",
      params: { lookback_days: 126 },
      metrics: { primary_metric: "0.31" },
      costScenario: "base",
      codeCommit: "4f7a2c9e1b0d",
      snapshotIds: [snapshotId],
      resultHash: SHA,
      runStarted: utc("2026-09-08T15:01:44Z"),
      runFinished: utc("2026-09-08T15:03:10Z"),
    };
    reg.recordTrial(base);
    // A universe read for this cell came back SURVIVORSHIP_BIASED; the label lives only on the trial row.
    reg.recordTrial({ ...base, params: { lookback_days: 252 }, labels: ["SURVIVORSHIP_BIASED"] });
    reg.markResultsViewed(clean.experimentId, { viewedBy: "owner" });
    reg.openHoldout(clean.experimentId, { reason: "reviewed", requestedBy: "owner" });
    expect(() => reg.setPromotionEvidence(clean.experimentId, true, { requestedBy: "owner" })).toThrow(/SURVIVORSHIP_BIASED/);
    expect(reg.get(clean.experimentId).promotionEvidenceAt).toBeNull();
    // Withdrawing is still allowed.
    expect(reg.setPromotionEvidence(clean.experimentId, false, { requestedBy: "owner" }).promotionEvidenceAt).toBeNull();
  });
});
