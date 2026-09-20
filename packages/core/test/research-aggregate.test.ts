import { describe, expect, it } from "vitest";
import { Dec, isoDate, type IsoDate } from "@blackgold/shared";
import { fileURLToPath } from "node:url";
import { charterHash, loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import { aggregateWalkForward, AggregateScopeError, SECONDARY_2_OPEN_READINGS, type AggregateSplitInput } from "../src/research/aggregate.ts";
import { annualizedSharpe, annualizedSharpeDifference, stationaryBootstrapPaired } from "../src/research/stats.ts";
import type { SharpeInputPoint } from "../src/research/report.ts";

/**
 * ALPHA_CHARTER section 16.1 on the aggregate walk-forward out-of-sample set (D-51 step 2).
 *
 * Every fixture here is built so the branch under test CHANGES THE ANSWER. That is not style: nine tests
 * across PRs #91-#93 passed against mutated code because their fixtures were uniform in the dimension the
 * code branches on. So the chain-link test uses returns whose sum and product disagree in SIGN, the
 * statistic test uses legs whose Sharpe difference and information ratio disagree in SIGN, the completeness
 * test uses a pool that would otherwise reject, and the unmeasured-prong test uses one that would too.
 */

function charter(mut: (c: Charter) => void = () => undefined): Charter {
  const base = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
  const c = structuredClone(base);
  mut(c);
  return c;
}

const RESAMPLES = 200;
const SEED = 7;

function sessions(startDay: number, count: number): IsoDate[] {
  const out: IsoDate[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(2026, 0, startDay + i));
    out.push(isoDate(d.toISOString().slice(0, 10)));
  }
  return out;
}

/** A pair of excess-over-cash legs: the strategy's and the primary benchmark's. */
type Legs = { strategy: (i: number) => number; benchmark: (i: number) => number };

/** The strategy's Sharpe far BELOW the benchmark's: section 13's threshold test fails. */
const LOSING: Legs = {
  strategy: (i) => (i % 2 === 0 ? -0.004 : -0.002),
  benchmark: (i) => (i % 2 === 0 ? 0.002 : 0.004),
};

/** The strategy's Sharpe far ABOVE the benchmark's: the threshold test clears (the prong is then withheld). */
const CLEARING: Legs = { strategy: LOSING.benchmark, benchmark: LOSING.strategy };

function inputs(ss: readonly IsoDate[], legs: Legs): SharpeInputPoint[] {
  return ss.map((session, i) => ({ session, strategy: legs.strategy(i), benchmark: legs.benchmark(i) }));
}

type SplitOverrides = Partial<AggregateSplitInput>;

function split(id: string, startDay: number, count: number, legs: Legs, over: SplitOverrides = {}): AggregateSplitInput {
  const ss = sessions(startDay, count);
  return {
    splitId: id,
    kind: "WALK_FORWARD",
    sessions: ss,
    sharpeInputs: inputs(ss, legs),
    candidateTotalReturn: new Dec("0.10"),
    secondary2TotalReturn: new Dec("0.20"),
    secondary2UnusableReason: undefined,
    citableAsEvidence: true,
    citabilityReasons: [],
    promotionBlockingCodes: [],
    ...over,
  };
}

/** Secondary 2 beaten: the candidate out-returns it. */
const BEATS_SECONDARY_2: SplitOverrides = { candidateTotalReturn: new Dec("0.30"), secondary2TotalReturn: new Dec("0.10") };

function run(c: Charter, splits: readonly AggregateSplitInput[], planned?: readonly string[]) {
  return aggregateWalkForward({
    charter: c,
    // Derived from the charter under test, not a constant, so a charter edit really does move it.
    charterHash: charterHash(c),
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
    const a = split("walk_forward/a", 2, 40, LOSING);
    const b = split("walk_forward/b", 30, 40, LOSING); // days 30..69 overlaps days 2..41
    expect(() => run(charter(SMALL_MINIMUM), [a, b], ["walk_forward/a", "walk_forward/b"])).toThrow(/both score/);
  });
});

describe("aggregateWalkForward: the registered statistic", () => {
  // ALPHA_CHARTER section 13 registers "difference in after-cost annualized Sharpe ratio between the
  // strategy and VTI total return". Until 2026-09-20 the code bootstrapped the Sharpe of the paired
  // DIFFERENCE, which is the information ratio - `informationRatio` in benchmarks.ts is literally that same
  // construction, so the report published one number twice under two names. Found by Codex on PR #94.
  it("is a difference of Sharpe ratios, not the Sharpe of the difference", () => {
    // Legs chosen so the two readings disagree in SIGN. The benchmark has a small mean and a tiny
    // volatility, so its Sharpe is enormous; the strategy has a larger mean and a far larger volatility, so
    // its Sharpe is small. The strategy still out-returns the benchmark session by session on average, so
    // the information ratio is positive while the Sharpe difference is deeply negative.
    const legs: Legs = {
      strategy: (i) => (i % 2 === 0 ? -0.01 : 0.03),
      benchmark: (i) => (i % 2 === 0 ? 0.0010 : 0.0012),
    };
    const s = split("walk_forward/a", 2, 60, legs);
    const strategy = s.sharpeInputs.map((p) => p.strategy);
    const benchmark = s.sharpeInputs.map((p) => p.benchmark);
    const informationRatio = annualizedSharpe(strategy.map((v, i) => v - (benchmark[i] ?? 0)));
    const sharpeDifference = annualizedSharpe(strategy) - annualizedSharpe(benchmark);

    // The fixture is only worth anything if the two readings really do disagree in sign.
    expect(informationRatio).toBeGreaterThan(0);
    expect(sharpeDifference).toBeLessThan(0);

    const r = run(charter(SMALL_MINIMUM), [s]);
    expect(r.primaryMetric?.pointEstimate).toBe(sharpeDifference);
    expect(r.primaryMetric?.pointEstimate).not.toBe(informationRatio);
    // And the verdict follows the registered reading: the prong FAILED, so it is acted on rather than
    // withheld, and with Secondary 2 also failing the aggregate rejects.
    expect(r.primaryMetric?.clearsUndeflatedThreshold).toBe(false);
    expect(r.primaryMetric?.passes).toBe(false);
    expect(r.verdict).toBe("REJECT");
  });

  it("resamples both legs under one draw of block indices", () => {
    const a = split("walk_forward/a", 2, 60, LOSING);
    const b = split("walk_forward/b", 64, 60, CLEARING);
    const r = run(charter(SMALL_MINIMUM), [b, a]);

    const strategy = [...a.sharpeInputs, ...b.sharpeInputs].map((p) => p.strategy);
    const benchmark = [...a.sharpeInputs, ...b.sharpeInputs].map((p) => p.benchmark);
    const reference = stationaryBootstrapPaired(strategy, benchmark, annualizedSharpeDifference, {
      meanBlockSessions: 21,
      confidence: 0.9,
      resamples: RESAMPLES,
      seed: SEED,
    });
    expect(r.primaryMetric?.pointEstimate).toBe(reference.pointEstimate);
    expect(r.primaryMetric?.interval.lower).toBe(reference.lower);
    expect(r.primaryMetric?.interval.upper).toBe(reference.upper);
    expect(r.primaryMetric?.observations).toBe(120);

    // Pooled, not averaged: the statistic over the concatenation is not the mean of the two split statistics.
    const perSplit = [a, b].map((s) => annualizedSharpeDifference(s.sharpeInputs.map((p) => p.strategy), s.sharpeInputs.map((p) => p.benchmark)));
    expect(perSplit[0]).not.toBe(perSplit[1]);
    expect(r.primaryMetric?.pointEstimate).not.toBe(((perSplit[0] ?? 0) + (perSplit[1] ?? 0)) / 2);

    // And in evaluation order: the block bootstrap draws contiguous runs, so reversing the concatenation
    // changes the interval. Sorting the splits by window is doing work, not decoration.
    const reversed = stationaryBootstrapPaired([...strategy].reverse(), [...benchmark].reverse(), annualizedSharpeDifference, {
      meanBlockSessions: 21,
      confidence: 0.9,
      resamples: RESAMPLES,
      seed: SEED,
    });
    expect(reversed.lower === reference.lower && reversed.upper === reference.upper).toBe(false);
  });
});

describe("aggregateWalkForward: pooling", () => {
  it("pools the splits in evaluation order and reports the window they span", () => {
    const a = split("walk_forward/a", 2, 40, LOSING);
    const b = split("walk_forward/b", 42, 40, LOSING);
    const r = run(charter(SMALL_MINIMUM), [b, a]); // deliberately out of order
    expect(r.splitIds).toEqual(["walk_forward/a", "walk_forward/b"]);
    expect(r.sessions).toBe(80);
    expect(r.window).toEqual({ start: sessions(2, 1)[0], end: sessions(42, 40)[39] });
    expect(r.splitBoundaries).toBe(1);
    expect(r.complete).toBe(true);
  });

  it("links the per-split returns instead of adding them", () => {
    // Chosen so the two aggregation rules disagree in SIGN:
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
    const r = run(charter(SMALL_MINIMUM), [split("walk_forward/a", 2, 40, LOSING), split("walk_forward/b", 42, 40, LOSING)]);
    expect(r.primaryMetric?.passes).toBe(false);
    expect(r.secondary2?.beats).toBe(false);
    expect(r.verdict).toBe("REJECT");
    expect(r.charterConflict).toBeUndefined();
  });

  // Codex P1 on PR #94: a pass on the unadjusted statistic is not a registered pass, and recording the gap
  // in `evidenceCaveats` does not stop a consumer acting on the concrete verdict.
  it("withholds a passing first prong until the deflated-Sharpe adjustment is applied", () => {
    const r = run(charter(SMALL_MINIMUM), [split("walk_forward/a", 2, 40, CLEARING), split("walk_forward/b", 42, 40, CLEARING)]);
    // The threshold test itself clears - that is what makes this the case under test rather than a failure.
    expect(r.primaryMetric?.clearsUndeflatedThreshold).toBe(true);
    expect(r.primaryMetric?.pointEstimate).toBeGreaterThanOrEqual(r.primaryMetric?.threshold ?? 0);
    expect(r.primaryMetric?.interval.excludesZero).toBe(true);
    // ...and it is still not a pass, so no section 16.1 outcome follows from it.
    expect(r.primaryMetric?.passes).toBeUndefined();
    expect(r.primaryMetric?.deflatedSharpeApplied).toBe(false);
    expect(r.secondary2?.beats).toBe(false);
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.verdictReasons.join(" ")).toContain("An undeflated pass is not a registered pass");
  });

  it("still reaches owner review when Secondary 2 is beaten, whatever the withheld first prong would say", () => {
    // Section 16.1 asks whether EITHER prong passed, so a beaten Secondary 2 settles it on its own. The
    // first prong being unknown does not make the disjunction unknown.
    const r = run(charter(SMALL_MINIMUM), [
      split("walk_forward/a", 2, 40, CLEARING, BEATS_SECONDARY_2),
      split("walk_forward/b", 42, 40, CLEARING, BEATS_SECONDARY_2),
    ]);
    expect(r.primaryMetric?.passes).toBeUndefined();
    expect(r.secondary2?.beats).toBe(true);
    expect(r.verdict).toBe("OWNER_REVIEW");
    // Not the sections 16.1/17 conflict: that needs the metric to have FAILED, and here it is unknown.
    expect(r.charterConflict).toBeUndefined();
  });

  it("surfaces the sections 16.1 / 17 conflict when the metric fails and Secondary 2 is beaten", () => {
    const r = run(charter(SMALL_MINIMUM), [
      split("walk_forward/a", 2, 40, LOSING, BEATS_SECONDARY_2),
      split("walk_forward/b", 42, 40, LOSING, BEATS_SECONDARY_2),
    ]);
    expect(r.primaryMetric?.passes).toBe(false);
    expect(r.secondary2?.beats).toBe(true);
    expect(r.verdict).toBe("OWNER_REVIEW");
    expect(r.charterConflict).toContain("never to ACTIVE");
  });

  it("emits no verdict from part of the schedule, even when both prongs fail", () => {
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
    // The first prong FAILS here, so an implementation that read an absent comparator as "does not beat" -
    // or substituted zero for it - would emit a section 16.1 rejection.
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
    expect(r.verdictReasons.join(" ")).toContain("it is not established that BOTH failed");
  });

  it("leaves the first prong unmeasured rather than bootstrapping a padded series", () => {
    // buildResultReport pads a short series with [0, 0] to keep the per-split diagnostic shaped correctly.
    // A decisive verdict may not rest on a fabricated interval.
    const r = run(charter(SMALL_MINIMUM), [split("walk_forward/a", 2, 1, LOSING)]);
    expect(r.primaryMetric).toBeUndefined();
    expect(r.secondary2?.beats).toBe(false);
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.verdictReasons.join(" ")).toContain("at least two");
  });
});

describe("aggregateWalkForward: what the numbers may be read as", () => {
  it("states that the registered deflated-Sharpe adjustment is not applied, and which way it cuts", () => {
    const r = run(charter(SMALL_MINIMUM), [split("walk_forward/a", 2, 40, LOSING), split("walk_forward/b", 42, 40, LOSING)]);
    expect(r.primaryMetric?.deflatedSharpeApplied).toBe(false);
    const caveats = r.evidenceCaveats.join(" ");
    expect(caveats).toContain("deflated-Sharpe");
    expect(caveats).toContain("can take a pass away and can never grant one");
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
    // Citability is about the data, not the arithmetic: the verdict is still computed and reported.
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

  // Codex P2 on PR #94. Citability turns on things that move no number - a charter that stops being
  // registrable, a promotion-blocking data code appearing on a source - so an aggregate that may be cited
  // could otherwise share a hash with one explicitly barred from use. The hash is what a PR body quotes to
  // identify a result, which is precisely where that confusion would do damage.
  // Codex P2 on PR #94. `charter_version` does not identify a charter: contents change without the version
  // moving. Most charter values never reach the hashed body directly either, so without the content hash a
  // verdict keeps its identity while the rule it was judged against changes underneath it.
  it("separates two runs judged under different charter contents at the same version", () => {
    const splits = [split("walk_forward/a", 2, 40, LOSING), split("walk_forward/b", 42, 40, LOSING)];
    // The sharpest case: an estimate that fails BOTH thresholds. Everything the body carries besides the
    // charter hash is identical - numbers, prong state, verdict, citability - and the version does not move.
    const lenient = run(charter((c) => (c.pass_fail.primary_threshold = "0.10")), splits);
    const strict = run(charter((c) => (c.pass_fail.primary_threshold = "0.20")), splits);

    expect(strict.charterVersion).toBe(lenient.charterVersion);
    expect(strict.primaryMetric?.pointEstimate).toBe(lenient.primaryMetric?.pointEstimate);
    expect(strict.primaryMetric?.passes).toBe(false);
    expect(lenient.primaryMetric?.passes).toBe(false);
    expect(strict.verdict).toBe(lenient.verdict);
    expect(strict.citableAsEvidence).toBe(lenient.citableAsEvidence);
    // Only the charter's contents differ, and the hash has to see it.
    expect(strict.charterHash).not.toBe(lenient.charterHash);
    expect(strict.aggregateHash).not.toBe(lenient.aggregateHash);
  });

  it("separates a citable aggregate from one barred from evidence", () => {
    const citable = run(charter(SMALL_MINIMUM), [split("walk_forward/a", 2, 40, LOSING), split("walk_forward/b", 42, 40, LOSING)]);
    const barred = run(charter(SMALL_MINIMUM), [
      split("walk_forward/a", 2, 40, LOSING, { citableAsEvidence: false, citabilityReasons: ["approval.state is DRAFT"] }),
      split("walk_forward/b", 42, 40, LOSING),
    ]);

    // Same windows, same arithmetic, same verdict - only the evidence eligibility differs.
    expect(barred.primaryMetric?.pointEstimate).toBe(citable.primaryMetric?.pointEstimate);
    expect(barred.secondary2).toEqual(citable.secondary2);
    expect(barred.verdict).toBe(citable.verdict);
    expect(citable.citableAsEvidence).toBe(true);
    expect(barred.citableAsEvidence).toBe(false);
    expect(citable.aggregateHash).not.toBe(barred.aggregateHash);
  });

  it("separates two barred aggregates that are barred for different reasons", () => {
    const base = (reason: string, code: string) =>
      run(charter(SMALL_MINIMUM), [
        split("walk_forward/a", 2, 40, LOSING, { citableAsEvidence: false, citabilityReasons: [reason], promotionBlockingCodes: [code] }),
        split("walk_forward/b", 42, 40, LOSING),
      ]);
    const draft = base("approval.state is DRAFT", "UNVERIFIED_SINGLE_SOURCE");
    const synthetic = base("synthetic missing data", "SYNTHETIC_MISSING_DATA");
    expect(draft.citableAsEvidence).toBe(false);
    expect(synthetic.citableAsEvidence).toBe(false);
    expect(draft.verdict).toBe(synthetic.verdict);
    // The flag alone would make these identical; the reasons and codes ride along with it.
    expect(draft.aggregateHash).not.toBe(synthetic.aggregateHash);
  });

  it("separates a withheld first prong from a failed one", () => {
    // These two runs agree on EVERYTHING else the body carries - same splits, same sessions, same point
    // estimate and interval, same second prong, same OWNER_REVIEW verdict. Only the threshold differs, so
    // only the prong's tri-state differs. An earlier version of this test used fixtures that also differed
    // in the second prong, so it passed against a body with the tri-state removed: it was proving something
    // other than what it claimed.
    //
    // The distinction is not bookkeeping. The failed-prong run is the case sections 16.1 and 17 disagree
    // on; the withheld one is not. Two verdicts that route the charter differently must not share a hash.
    const splits = [split("walk_forward/a", 2, 40, CLEARING, BEATS_SECONDARY_2), split("walk_forward/b", 42, 40, CLEARING, BEATS_SECONDARY_2)];
    const withheld = run(charter(SMALL_MINIMUM), splits);
    const failed = run(
      charter((c) => {
        SMALL_MINIMUM(c);
        // Unreachably high, so the same interval fails the threshold test instead of clearing it.
        c.pass_fail.primary_threshold = "1000000";
      }),
      splits,
    );

    expect(withheld.primaryMetric?.passes).toBeUndefined();
    expect(failed.primaryMetric?.passes).toBe(false);
    expect(withheld.verdict).toBe("OWNER_REVIEW");
    expect(failed.verdict).toBe("OWNER_REVIEW");
    // Everything else the hashed body reads is identical...
    expect(failed.primaryMetric?.pointEstimate).toBe(withheld.primaryMetric?.pointEstimate);
    expect(failed.primaryMetric?.interval.lower).toBe(withheld.primaryMetric?.interval.lower);
    expect(failed.primaryMetric?.interval.upper).toBe(withheld.primaryMetric?.interval.upper);
    expect(failed.secondary2).toEqual(withheld.secondary2);
    expect(failed.splitIds).toEqual(withheld.splitIds);
    // ...and only one of them is the sections 16.1 / 17 conflict.
    expect(withheld.charterConflict).toBeUndefined();
    expect(failed.charterConflict).toBeDefined();
    expect(withheld.aggregateHash).not.toBe(failed.aggregateHash);
  });
});
