import { describe, expect, it } from "vitest";
import { Dec, isoDate, type IsoDate } from "@blackgold/shared";
import { fileURLToPath } from "node:url";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import { aggregateWalkForward, AggregateScopeError, SECONDARY_2_OPEN_READINGS, type AggregateSplitInput } from "../src/research/aggregate.ts";
import { annualizedSharpe, stationaryBootstrap } from "../src/research/stats.ts";

/**
 * ALPHA_CHARTER section 16.1 on the aggregate walk-forward out-of-sample set (D-51 step 2).
 *
 * Every fixture here is built so the branch under test CHANGES THE ANSWER. That is not style: nine tests
 * across PRs #91-#93 passed against mutated code because their fixtures were uniform in the dimension the
 * code branches on. So the chain-link test uses returns whose sum and product disagree in SIGN, the
 * completeness test uses a pool that would otherwise reject, and the unmeasured-prong test uses one that
 * would too. Each assertion below fails if the guard it names is deleted.
 */

function charter(mut: (c: Charter) => void = () => undefined): Charter {
  const base = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
  const c = structuredClone(base);
  mut(c);
  return c;
}

const RESAMPLES = 200;
const SEED = 7;

/** Sessions for a split, starting at `startDay` of January 2026 (the fixture calendar is irrelevant here). */
function sessions(startDay: number, count: number): IsoDate[] {
  const out: IsoDate[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(2026, 0, startDay + i));
    out.push(isoDate(d.toISOString().slice(0, 10)));
  }
  return out;
}

function paired(ss: readonly IsoDate[], f: (i: number) => number): { session: IsoDate; value: number }[] {
  return ss.map((session, i) => ({ session, value: f(i) }));
}

/** Excess series with a clearly negative Sharpe: the primary prong fails on it. */
const LOSING = (i: number): number => (i % 2 === 0 ? -0.002 : -0.004);
/** Excess series with a clearly positive Sharpe well above the +0.10 threshold: the primary prong passes. */
const WINNING = (i: number): number => (i % 2 === 0 ? 0.002 : 0.004);

type SplitOverrides = Partial<AggregateSplitInput>;

function split(id: string, startDay: number, count: number, f: (i: number) => number, over: SplitOverrides = {}): AggregateSplitInput {
  const ss = sessions(startDay, count);
  return {
    splitId: id,
    kind: "WALK_FORWARD",
    sessions: ss,
    pairedExcess: paired(ss, f),
    candidateTotalReturn: new Dec("0.10"),
    secondary2TotalReturn: new Dec("0.20"),
    secondary2UnusableReason: undefined,
    citableAsEvidence: true,
    citabilityReasons: [],
    promotionBlockingCodes: [],
    ...over,
  };
}

function run(c: Charter, splits: readonly AggregateSplitInput[], planned?: readonly string[]) {
  return aggregateWalkForward({
    charter: c,
    splits,
    plannedSplitIds: planned ?? splits.map((s) => s.splitId),
    bootstrapResamples: RESAMPLES,
    bootstrapSeed: SEED,
  });
}

// A charter whose minimum-independent-decision count the small fixtures can meet, so the caveat under test
// is the one the test names rather than that one firing on every fixture.
const SMALL_MINIMUM = (c: Charter): void => {
  c.pass_fail.minimum_independent_decisions = 2;
};

describe("aggregateWalkForward: scope", () => {
  it("refuses a split that is not a walk-forward split", () => {
    // DESIGN is in-sample (section 14.1) and RECENT is quasi-forward and reported separately. Pooling either
    // into section 16.1's set would state an out-of-sample verdict over data that is not out of sample.
    const design = { ...split("design/a", 2, 40, LOSING), kind: "DESIGN" as const };
    expect(() => run(charter(SMALL_MINIMUM), [design], ["design/a"])).toThrow(AggregateScopeError);
    expect(() => run(charter(SMALL_MINIMUM), [{ ...design, kind: "RECENT" as const }], ["design/a"])).toThrow(/RECENT/);
  });

  it("refuses a split that is not in the charter's walk-forward schedule", () => {
    expect(() => run(charter(SMALL_MINIMUM), [split("walk_forward/rogue", 2, 40, LOSING)], ["walk_forward/a"])).toThrow(
      /not in the charter's walk-forward schedule/,
    );
  });

  it("refuses two splits that score the same session, rather than double-counting it", () => {
    // splitPlan tiles the schedule without overlap, so an overlap here is a scheduler defect. Returning an
    // "unmeasured" verdict for it would hide a bug behind a legitimate-looking outcome.
    const a = split("walk_forward/a", 2, 40, LOSING);
    const b = split("walk_forward/b", 30, 40, LOSING); // days 30..69 overlaps days 2..41
    expect(() => run(charter(SMALL_MINIMUM), [a, b], ["walk_forward/a", "walk_forward/b"])).toThrow(/both score/);
  });
});

describe("aggregateWalkForward: pooling", () => {
  it("pools the splits in evaluation order and reports the window they span", () => {
    const a = split("walk_forward/a", 2, 40, LOSING);
    const b = split("walk_forward/b", 42, 40, LOSING);
    // Deliberately out of order: the block bootstrap draws contiguous runs, so the sort is load-bearing.
    const r = run(charter(SMALL_MINIMUM), [b, a]);
    expect(r.splitIds).toEqual(["walk_forward/a", "walk_forward/b"]);
    expect(r.sessions).toBe(80);
    expect(r.window).toEqual({ start: sessions(2, 1)[0], end: sessions(42, 40)[39] });
    expect(r.splitBoundaries).toBe(1);
    expect(r.complete).toBe(true);
  });

  it("bootstraps the concatenated series in session order, not per-split statistics", () => {
    // The two splits have deliberately different distributions, so the pooled Sharpe is not the mean of the
    // per-split Sharpes and the interval depends on which order they are concatenated in.
    const a = split("walk_forward/a", 2, 60, () => 0.001);
    const b = split("walk_forward/b", 64, 60, (i) => (i % 2 === 0 ? -0.002 : 0.004));
    const r = run(charter(SMALL_MINIMUM), [b, a]);

    const concat = [...a.pairedExcess.map((p) => p.value), ...b.pairedExcess.map((p) => p.value)];
    const reference = stationaryBootstrap(concat, annualizedSharpe, {
      meanBlockSessions: 21,
      confidence: 0.9,
      resamples: RESAMPLES,
      seed: SEED,
    });
    expect(r.primaryMetric?.pointEstimate).toBe(reference.pointEstimate);
    expect(r.primaryMetric?.interval.lower).toBe(reference.lower);
    expect(r.primaryMetric?.interval.upper).toBe(reference.upper);
    expect(r.primaryMetric?.observations).toBe(120);

    // Not a per-split average: the pooled statistic differs from the mean of the two split Sharpes.
    const perSplit = [a, b].map((s) => annualizedSharpe(s.pairedExcess.map((p) => p.value)));
    const meanOfSplits = ((perSplit[0] ?? 0) + (perSplit[1] ?? 0)) / 2;
    expect(perSplit[0]).not.toBe(perSplit[1]);
    expect(r.primaryMetric?.pointEstimate).not.toBe(meanOfSplits);

    // And the order the splits were pooled in is the one that produced the interval: reversing the
    // concatenation changes it, so sorting by evaluation window is not cosmetic.
    const reversed = stationaryBootstrap([...concat].reverse(), annualizedSharpe, {
      meanBlockSessions: 21,
      confidence: 0.9,
      resamples: RESAMPLES,
      seed: SEED,
    });
    expect(reversed.lower === reference.lower && reversed.upper === reference.upper).toBe(false);
  });

  it("links the per-split returns instead of adding them", () => {
    // Chosen so the two aggregation rules disagree in SIGN, which is the whole point of the fixture:
    //   linked:  candidate 1.50 x 1.50 - 1 = +1.25   Secondary 2  2.00 x 1.10 - 1 = +1.20   excess +0.05
    //   summed:  candidate 0.50 + 0.50   = +1.00     Secondary 2  1.00 + 0.10   = +1.10     excess -0.10
    // So a summing implementation rejects the hypothesis where a linking one routes it to owner review.
    const a = split("walk_forward/a", 2, 40, LOSING, { candidateTotalReturn: new Dec("0.50"), secondary2TotalReturn: new Dec("1.00") });
    const b = split("walk_forward/b", 42, 40, LOSING, { candidateTotalReturn: new Dec("0.50"), secondary2TotalReturn: new Dec("0.10") });
    const r = run(charter(SMALL_MINIMUM), [a, b]);
    expect(r.secondary2?.candidateTotalReturn).toBe("1.25000000");
    expect(r.secondary2?.secondary2TotalReturn).toBe("1.20000000");
    expect(r.secondary2?.excessReturn).toBe("0.05000000");
    expect(r.secondary2?.beats).toBe(true);
    expect(r.verdict).toBe("OWNER_REVIEW");
  });
});

describe("aggregateWalkForward: section 16.1", () => {
  it("rejects only when both prongs are measured and both fail, over the whole schedule", () => {
    const a = split("walk_forward/a", 2, 40, LOSING);
    const b = split("walk_forward/b", 42, 40, LOSING);
    const r = run(charter(SMALL_MINIMUM), [a, b]);
    expect(r.primaryMetric?.passes).toBe(false);
    expect(r.secondary2?.beats).toBe(false);
    expect(r.verdict).toBe("REJECT");
    expect(r.charterConflict).toBeUndefined();
  });

  it("routes to owner review when the primary metric passes", () => {
    // Secondary 2 still wins on return, so only the first prong passes. Under a conjunction this would
    // reject; section 16.1 says "if either passes".
    const a = split("walk_forward/a", 2, 40, WINNING);
    const b = split("walk_forward/b", 42, 40, WINNING);
    const r = run(charter(SMALL_MINIMUM), [a, b]);
    expect(r.primaryMetric?.passes).toBe(true);
    expect(r.secondary2?.beats).toBe(false);
    expect(r.verdict).toBe("OWNER_REVIEW");
    // Sections 16.1 and 17 agree here: the metric passed, so section 17 does not bar promotion.
    expect(r.charterConflict).toBeUndefined();
  });

  it("surfaces the sections 16.1 / 17 conflict when the metric fails and Secondary 2 is beaten", () => {
    const over = { candidateTotalReturn: new Dec("0.30"), secondary2TotalReturn: new Dec("0.10") };
    const a = split("walk_forward/a", 2, 40, LOSING, over);
    const b = split("walk_forward/b", 42, 40, LOSING, over);
    const r = run(charter(SMALL_MINIMUM), [a, b]);
    expect(r.primaryMetric?.passes).toBe(false);
    expect(r.secondary2?.beats).toBe(true);
    expect(r.verdict).toBe("OWNER_REVIEW");
    expect(r.charterConflict).toBeDefined();
    expect(r.charterConflict).toContain("never to ACTIVE");
    expect(r.charterConflict).toContain("owner");
  });

  it("emits no verdict from part of the schedule, even when both prongs fail", () => {
    // Same data as the rejection above, with one scheduled window absent. A verdict here would be decided by
    // which `--split` the operator passed.
    const a = split("walk_forward/a", 2, 40, LOSING);
    const b = split("walk_forward/b", 42, 40, LOSING);
    const r = run(charter(SMALL_MINIMUM), [a, b], ["walk_forward/a", "walk_forward/b", "walk_forward/c"]);
    expect(r.complete).toBe(false);
    // The prong numbers are still reported - they are what the runs computed - and both still fail.
    expect(r.primaryMetric?.passes).toBe(false);
    expect(r.secondary2?.beats).toBe(false);
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.verdictReasons.join(" ")).toContain("walk_forward/c");
    expect(r.citableAsEvidence).toBe(false);
  });

  it("leaves the second prong unmeasured when one split has no usable Secondary 2, and does not reject", () => {
    // The first prong fails, so an implementation that read an absent comparator as "does not beat" - or
    // substituted zero for it - would emit a section 16.1 rejection here.
    const a = split("walk_forward/a", 2, 40, LOSING);
    const b = split("walk_forward/b", 42, 40, LOSING, {
      secondary2TotalReturn: undefined,
      secondary2UnusableReason: "no usable open on 2026-02-17",
    });
    const r = run(charter(SMALL_MINIMUM), [a, b]);
    expect(r.secondary2).toBeUndefined();
    expect(r.secondary2UnmeasuredReasons).toEqual(["walk_forward/b: no usable open on 2026-02-17"]);
    expect(r.primaryMetric?.passes).toBe(false);
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.verdictReasons.join(" ")).toContain("absence is not failure");
  });

  it("leaves the first prong unmeasured rather than bootstrapping a padded series", () => {
    // buildResultReport pads a short series with [0, 0] to keep the per-split diagnostic shaped correctly.
    // A decisive verdict may not rest on a fabricated interval, so the aggregate reports nothing instead.
    const one = split("walk_forward/a", 2, 1, LOSING);
    const r = run(charter(SMALL_MINIMUM), [one]);
    expect(r.primaryMetric).toBeUndefined();
    expect(r.secondary2?.beats).toBe(false);
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.verdictReasons.join(" ")).toContain("at least two");
  });
});

describe("aggregateWalkForward: what the numbers may be read as", () => {
  it("states that the registered deflated-Sharpe adjustment is not applied, and which way it biases", () => {
    const r = run(charter(SMALL_MINIMUM), [split("walk_forward/a", 2, 40, LOSING), split("walk_forward/b", 42, 40, LOSING)]);
    expect(r.primaryMetric?.deflatedSharpeApplied).toBe(false);
    const caveats = r.evidenceCaveats.join(" ");
    expect(caveats).toContain("deflated-Sharpe");
    expect(caveats).toContain("away from rejection");
  });

  it("carries Secondary 2's open owner readings only when the second prong is measured", () => {
    const measured = run(charter(SMALL_MINIMUM), [split("walk_forward/a", 2, 40, LOSING), split("walk_forward/b", 42, 40, LOSING)]);
    for (const reading of SECONDARY_2_OPEN_READINGS) expect(measured.evidenceCaveats).toContain(reading);

    const unmeasured = run(charter(SMALL_MINIMUM), [
      split("walk_forward/a", 2, 40, LOSING),
      split("walk_forward/b", 42, 40, LOSING, { secondary2TotalReturn: undefined, secondary2UnusableReason: "not built" }),
    ]);
    for (const reading of SECONDARY_2_OPEN_READINGS) expect(unmeasured.evidenceCaveats).not.toContain(reading);
  });

  it("notes the per-window restart from cash only when there is a boundary to restart at", () => {
    const two = run(charter(SMALL_MINIMUM), [split("walk_forward/a", 2, 40, LOSING), split("walk_forward/b", 42, 40, LOSING)]);
    expect(two.evidenceCaveats.join(" ")).toContain("at each of the 1 boundaries the strategy sits flat");
    const one = run(charter(SMALL_MINIMUM), [split("walk_forward/a", 2, 40, LOSING)]);
    expect(one.splitBoundaries).toBe(0);
    expect(one.evidenceCaveats.join(" ")).not.toContain("sits flat");
  });

  it("compares the pooled independent-decision count against the charter's own minimum, both ways", () => {
    // 80 sessions is 3 monthly-equivalent blocks.
    const splits = [split("walk_forward/a", 2, 40, LOSING), split("walk_forward/b", 42, 40, LOSING)];
    const met = run(charter((c) => (c.pass_fail.minimum_independent_decisions = 3)), splits);
    expect(met.independentDecisions).toBe(3);
    expect(met.minimumIndependentDecisionsMet).toBe(true);
    expect(met.evidenceCaveats.join(" ")).not.toContain("monthly-equivalent independent blocks");

    const short = run(charter((c) => (c.pass_fail.minimum_independent_decisions = 4)), splits);
    expect(short.minimumIndependentDecisionsMet).toBe(false);
    expect(short.evidenceCaveats.join(" ")).toContain("3 monthly-equivalent independent blocks against the charter's minimum of 4");
    // Section 16.1 states no such precondition, so the verdict is still computed.
    expect(short.verdict).toBe("REJECT");
  });

  it("carries every split's citability reason and the union of promotion-blocking codes", () => {
    const a = split("walk_forward/a", 2, 40, LOSING, {
      citableAsEvidence: false,
      citabilityReasons: ["UNVERIFIED_SINGLE_SOURCE bars"],
      promotionBlockingCodes: ["UNVERIFIED_SINGLE_SOURCE"],
    });
    const b = split("walk_forward/b", 42, 40, LOSING, { promotionBlockingCodes: ["SYNTHETIC_MISSING_DATA"] });
    const r = run(charter(SMALL_MINIMUM), [a, b]);
    expect(r.citableAsEvidence).toBe(false);
    expect(r.citabilityReasons).toEqual(["walk_forward/a: UNVERIFIED_SINGLE_SOURCE bars"]);
    expect(r.promotionBlockingCodes).toEqual(["SYNTHETIC_MISSING_DATA", "UNVERIFIED_SINGLE_SOURCE"]);
    // Citability is about the data, not about the arithmetic: the verdict is still computed and reported.
    expect(r.verdict).toBe("REJECT");
  });
});

describe("aggregateWalkForward: hash", () => {
  it("is stable under the order the splits arrive in", () => {
    const a = split("walk_forward/a", 2, 40, LOSING);
    const b = split("walk_forward/b", 42, 40, LOSING);
    expect(run(charter(SMALL_MINIMUM), [a, b]).aggregateHash).toBe(run(charter(SMALL_MINIMUM), [b, a]).aggregateHash);
  });

  it("separates an unmeasured verdict from a measured rejection", () => {
    // The robustness verdict hash learned this the hard way: leave the tri-state out of the body and a
    // withheld prong and a measured failure become indistinguishable in persisted evidence.
    const a = split("walk_forward/a", 2, 40, LOSING);
    const rejected = run(charter(SMALL_MINIMUM), [a, split("walk_forward/b", 42, 40, LOSING)]);
    const unmeasured = run(charter(SMALL_MINIMUM), [
      a,
      split("walk_forward/b", 42, 40, LOSING, { secondary2TotalReturn: undefined, secondary2UnusableReason: "not built" }),
    ]);
    expect(rejected.verdict).toBe("REJECT");
    expect(unmeasured.verdict).toBe("UNMEASURED");
    expect(rejected.aggregateHash).not.toBe(unmeasured.aggregateHash);
  });
});
