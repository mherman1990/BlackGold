import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Dec, ZERO } from "@blackgold/shared";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import { adjacentPoints, enumerateGrid, enumerateTiers, evaluateFalsifiers, ROBUSTNESS_VERSION, type FalsifierMetrics } from "../src/research/robustness.ts";

const N = (s: string): Dec => new Dec(s);

function charter(): Charter {
  return loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
}

/** Metrics that pass every falsifier, so each test can break exactly one thing. */
function passingMetrics(): FalsifierMetrics {
  return {
    primaryPointEstimate: 0.25,
    primaryIntervalLower: 0.08,
    primaryIntervalUpper: 0.42,
    strategyMaxDrawdown: N("-0.20"),
    benchmarkMaxDrawdown: N("-0.50"),
    primaryUnderAdverseCosts: 0.18,
    primaryUnderExtraDelay: 0.16,
    primaryWithoutBestYear: 0.19,
    gridPointEstimates: Array.from({ length: 72 }, (_, i) => (i < 60 ? 0.2 : -0.05)),
    primaryVersusVolatilityControlled: 0.12,
    independentDecisions: 160,
  };
}

describe("enumerateGrid", () => {
  it("enumerates exactly the charter's declared 72 members", () => {
    const g = enumerateGrid(charter());
    expect(g.trialCount).toBe(72);
    expect(g.points).toHaveLength(72);
    expect(g.gridHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("contains the registered point and reports its index", () => {
    const c = charter();
    const g = enumerateGrid(c);
    expect(g.registeredIndex).toBeGreaterThanOrEqual(0);
    const registered = g.points[g.registeredIndex];
    expect(registered?.momentumLookbackSessions).toBe(c.features.momentum_lookback_sessions);
    expect(registered?.trendSmaSessions).toBe(c.features.trend_sma_sessions);
    expect(registered?.entryRank).toBe(c.rules.entry_rank);
    expect(registered?.holdRank).toBe(c.rules.hold_rank);
    expect(registered?.annualVolatilityTarget.eq(N(c.sizing.annual_volatility_target))).toBe(true);
  });

  it("produces every member exactly once, in a stable order", () => {
    const a = enumerateGrid(charter());
    const b = enumerateGrid(charter());
    expect(a.gridHash).toBe(b.gridHash);
    const keys = a.points.map((p) => JSON.stringify(p));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("derives the trial count from the charter, so the two can never disagree", () => {
    const c = charter();
    c.sensitivity_grid.volatility_sessions = [63, 42];
    const g = enumerateGrid(c);
    expect(g.trialCount).toBe(144);
    expect(g.points).toHaveLength(g.trialCount);
  });
});

describe("adjacentPoints", () => {
  it("finds only the neighbours differing in exactly one dimension", () => {
    const g = enumerateGrid(charter());
    const neighbours = adjacentPoints(g, g.registeredIndex);
    const registered = g.points[g.registeredIndex];
    if (!registered) throw new Error("no registered point");
    expect(neighbours.length).toBeGreaterThan(0);
    for (const i of neighbours) {
      const p = g.points[i];
      if (!p) continue;
      const differing = [
        p.momentumLookbackSessions !== registered.momentumLookbackSessions || p.momentumSkipSessions !== registered.momentumSkipSessions,
        p.trendSmaSessions !== registered.trendSmaSessions,
        p.volatilitySessions !== registered.volatilitySessions,
        p.entryRank !== registered.entryRank || p.holdRank !== registered.holdRank,
        !p.annualVolatilityTarget.eq(registered.annualVolatilityTarget),
        !p.rebalanceBandPctPoints.eq(registered.rebalanceBandPctPoints),
      ].filter(Boolean).length;
      expect(differing).toBe(1);
    }
    expect(neighbours).not.toContain(g.registeredIndex);
  });

  it("rejects an index outside the grid", () => {
    expect(() => adjacentPoints(enumerateGrid(charter()), 9999)).toThrow(RangeError);
  });
});

describe("enumerateTiers", () => {
  it("covers base, adverse, stress, every stress multiplier, delay and missing-data rate", () => {
    const tiers = enumerateTiers(charter());
    const ids = tiers.map((t) => t.id);
    expect(ids).toContain("cost/base");
    expect(ids).toContain("cost/adverse");
    expect(ids).toContain("cost/stress");
    expect(ids).toContain("cost/base_x2");
    expect(ids).toContain("cost/base_x4");
    expect(ids).toContain("delay/0");
    expect(ids).toContain("delay/2");
    expect(ids).toContain("delay/5");
    expect(ids).toContain("missing/0.02");
    expect(ids).toContain("missing/0.05");
  });

  it("does not duplicate the base tier as a multiplier, delay or missing rate", () => {
    const ids = enumerateTiers(charter()).map((t) => t.id);
    expect(ids).not.toContain("cost/base_x1");
    expect(ids).not.toContain("delay/1");
    expect(ids).not.toContain("missing/0");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks the tiers that can never be promotion evidence", () => {
    const tiers = enumerateTiers(charter());
    const zeroDelay = tiers.find((t) => t.id === "delay/0");
    expect(zeroDelay?.barsPromotionEvidence).toBe(true);
    for (const t of tiers.filter((x) => x.kind === "MISSING_DATA")) expect(t.barsPromotionEvidence).toBe(true);
    expect(tiers.find((t) => t.id === "cost/base")?.barsPromotionEvidence).toBe(false);
    expect(tiers.find((t) => t.id === "cost/adverse")?.barsPromotionEvidence).toBe(false);
  });
});

describe("evaluateFalsifiers", () => {
  it("passes a result that clears every declared condition", () => {
    const v = evaluateFalsifiers(charter(), passingMetrics());
    expect(v.passes).toBe(true);
    expect(v.failedIds).toEqual([]);
    expect(v.decisiveRejection).toBe(false);
    expect(v.robustnessVersion).toBe(ROBUSTNESS_VERSION);
    expect(v.verdictHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("F1 fires below the threshold or when the interval includes zero", () => {
    const low = evaluateFalsifiers(charter(), { ...passingMetrics(), primaryPointEstimate: 0.05 });
    expect(low.failedIds).toContain("F1");
    const straddling = evaluateFalsifiers(charter(), { ...passingMetrics(), primaryIntervalLower: -0.03 });
    expect(straddling.failedIds).toContain("F1");
    expect(straddling.outcomes.find((o) => o.id === "F1")?.detail).toContain("includes zero");
  });

  it("F1 treats the threshold itself as a pass, not a failure", () => {
    const atThreshold = evaluateFalsifiers(charter(), { ...passingMetrics(), primaryPointEstimate: 0.1 });
    expect(atThreshold.failedIds).not.toContain("F1");
    const justBelow = evaluateFalsifiers(charter(), { ...passingMetrics(), primaryPointEstimate: 0.0999 });
    expect(justBelow.failedIds).toContain("F1");
  });

  it("F2 fires when the drawdown ratio is not met, and passes exactly at the limit", () => {
    // The charter requires strategy drawdown at or below 0.75 of the benchmark's.
    const atLimit = evaluateFalsifiers(charter(), { ...passingMetrics(), strategyMaxDrawdown: N("-0.375"), benchmarkMaxDrawdown: N("-0.50") });
    expect(atLimit.failedIds).not.toContain("F2");
    const over = evaluateFalsifiers(charter(), { ...passingMetrics(), strategyMaxDrawdown: N("-0.376"), benchmarkMaxDrawdown: N("-0.50") });
    expect(over.failedIds).toContain("F2");
  });

  it("F3 fires when the sign flips under adverse costs or extra delay", () => {
    expect(evaluateFalsifiers(charter(), { ...passingMetrics(), primaryUnderAdverseCosts: -0.02 }).failedIds).toContain("F3");
    expect(evaluateFalsifiers(charter(), { ...passingMetrics(), primaryUnderExtraDelay: -0.01 }).failedIds).toContain("F3");
  });

  it("F4 fires when removing the best window flips the sign", () => {
    expect(evaluateFalsifiers(charter(), { ...passingMetrics(), primaryWithoutBestYear: -0.04 }).failedIds).toContain("F4");
  });

  it("F5 fires below the charter's grid sign agreement", () => {
    const half = evaluateFalsifiers(charter(), { ...passingMetrics(), gridPointEstimates: Array.from({ length: 72 }, (_, i) => (i < 36 ? 0.2 : -0.2)) });
    expect(half.failedIds).toContain("F5");
    expect(half.gridSignAgreement.eq(N("0.5"))).toBe(true);
    const strong = evaluateFalsifiers(charter(), { ...passingMetrics(), gridPointEstimates: Array.from({ length: 72 }, () => 0.2) });
    expect(strong.failedIds).not.toContain("F5");
    expect(strong.gridSignAgreement.eq(N("1"))).toBe(true);
  });

  it("F6 says plainly that it cannot be evaluated from history", () => {
    const v = evaluateFalsifiers(charter(), passingMetrics());
    const f6 = v.outcomes.find((o) => o.id === "F6");
    expect(f6?.triggered).toBe(false);
    expect(f6?.detail).toContain("prospective");
  });

  it("fails when the independent-decision minimum is not met", () => {
    const v = evaluateFalsifiers(charter(), { ...passingMetrics(), independentDecisions: 40 });
    expect(v.failedIds).toContain("MINIMUM_DECISIONS");
    expect(v.passes).toBe(false);
  });

  it("fails closed on a charter falsifier with no predicate", () => {
    const c = charter();
    c.pass_fail.falsifiers = [...c.pass_fail.falsifiers, { id: "F99", condition: "something the code does not know how to check" }];
    const v = evaluateFalsifiers(c, passingMetrics());
    expect(v.failedIds).toContain("F99");
    expect(v.outcomes.find((o) => o.id === "F99")?.detail).toContain("UNEVALUATED");
    expect(v.passes).toBe(false);
  });

  it("rejects decisively only when both the primary and the volatility-controlled bar are missed", () => {
    const onlyPrimaryFails = evaluateFalsifiers(charter(), { ...passingMetrics(), primaryPointEstimate: 0.02, primaryVersusVolatilityControlled: 0.05 });
    expect(onlyPrimaryFails.passes).toBe(false);
    expect(onlyPrimaryFails.decisiveRejection).toBe(false);

    const both = evaluateFalsifiers(charter(), { ...passingMetrics(), primaryPointEstimate: 0.02, primaryVersusVolatilityControlled: -0.03 });
    expect(both.decisiveRejection).toBe(true);

    const noComparator = evaluateFalsifiers(charter(), { ...passingMetrics(), primaryPointEstimate: 0.02, primaryVersusVolatilityControlled: undefined });
    expect(noComparator.decisiveRejection).toBe(true);
  });

  it("treats an empty grid as zero agreement rather than as a pass", () => {
    const v = evaluateFalsifiers(charter(), { ...passingMetrics(), gridPointEstimates: [] });
    expect(v.gridSignAgreement.eq(ZERO)).toBe(true);
    expect(v.failedIds).toContain("F5");
  });
});
