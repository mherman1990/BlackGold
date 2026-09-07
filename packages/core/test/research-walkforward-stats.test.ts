import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Dec, ONE, ZERO, isoDate, type IsoDate } from "@blackgold/shared";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import {
  designSplit,
  holdoutSplit,
  HoldoutSealedError,
  independentBlocks,
  recentSplit,
  splitPlan,
  SplitRangeError,
  walkForwardParamsFromCharter,
  walkForwardSplits,
} from "../src/research/walkforward.ts";
import {
  annualizedSharpe,
  concentrationReport,
  deflatedSharpe,
  excessKurtosis,
  mean,
  quantile,
  regimeLabels,
  seededRandom,
  skewness,
  stationaryBootstrap,
  stdev,
} from "../src/research/stats.ts";

const N = (s: string): Dec => new Dec(s);
const D = (s: string): IsoDate => isoDate(s);

function charter(): Charter {
  return loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
}

describe("walkForwardSplits", () => {
  const params = { windowYears: 3, stepMonths: 12, purgeDays: 21, embargoDays: 5 };

  it("produces contiguous, time-ordered, non-overlapping evaluation windows", () => {
    const splits = walkForwardSplits({ start: D("2007-06-01"), end: D("2018-12-31") }, params);
    expect(splits.length).toBeGreaterThan(5);
    for (let i = 1; i < splits.length; i++) {
      const prev = splits[i - 1];
      const cur = splits[i];
      if (!prev || !cur) continue;
      expect(cur.evaluation.start > prev.evaluation.end).toBe(true);
    }
    for (const s of splits) {
      expect(s.evaluation.end >= s.evaluation.start).toBe(true);
      expect(s.kind).toBe("WALK_FORWARD");
    }
  });

  it("separates design from evaluation by exactly purge plus embargo days", () => {
    const splits = walkForwardSplits({ start: D("2007-06-01"), end: D("2018-12-31") }, params);
    for (const s of splits) {
      const design = s.design;
      if (!design) throw new Error("a walk-forward split must have a design window");
      const gapDays = Math.round((Date.parse(`${s.evaluation.start}T00:00:00Z`) - Date.parse(`${design.end}T00:00:00Z`)) / 86_400_000);
      expect(gapDays).toBe(params.purgeDays + params.embargoDays + 1);
      // No calendar day is both designed on and evaluated in.
      expect(design.end < s.evaluation.start).toBe(true);
    }
  });

  it("never evaluates past the end of the range", () => {
    const splits = walkForwardSplits({ start: D("2007-06-01"), end: D("2013-06-30") }, params);
    for (const s of splits) expect(s.evaluation.end <= D("2013-06-30")).toBe(true);
    expect(splits[splits.length - 1]?.evaluation.end).toBe(D("2013-06-30"));
  });

  it("returns nothing when the range is shorter than one design window", () => {
    expect(walkForwardSplits({ start: D("2020-01-01"), end: D("2021-01-01") }, params)).toEqual([]);
  });

  it("clamps a month step that would overflow a short month", () => {
    const splits = walkForwardSplits({ start: D("2016-01-31"), end: D("2022-12-31") }, { ...params, stepMonths: 1 });
    for (const s of splits) expect(() => isoDate(s.evaluation.start)).not.toThrow();
  });

  it("rejects malformed parameters and a reversed range", () => {
    expect(() => walkForwardSplits({ start: D("2020-01-01"), end: D("2010-01-01") }, params)).toThrow(SplitRangeError);
    expect(() => walkForwardSplits({ start: D("2007-01-01"), end: D("2020-01-01") }, { ...params, windowYears: 0 })).toThrow(SplitRangeError);
    expect(() => walkForwardSplits({ start: D("2007-01-01"), end: D("2020-01-01") }, { ...params, stepMonths: 0 })).toThrow(SplitRangeError);
    expect(() => walkForwardSplits({ start: D("2007-01-01"), end: D("2020-01-01") }, { ...params, purgeDays: -1 })).toThrow(SplitRangeError);
  });
});

describe("splitPlan", () => {
  it("evaluates only the design and recent segments, never the holdout", () => {
    const c = charter();
    const plan = splitPlan(c);
    const holdoutStart = D(c.boundaries.holdout.start);
    const holdoutEnd = D(c.boundaries.holdout.end);
    expect(plan.holdout.opened).toBe(false);
    for (const s of plan.splits) {
      const overlaps = s.evaluation.start <= holdoutEnd && s.evaluation.end >= holdoutStart;
      expect(overlaps).toBe(false);
    }
    expect(plan.splits.some((s) => s.kind === "DESIGN")).toBe(true);
    expect(plan.splits.some((s) => s.kind === "WALK_FORWARD")).toBe(true);
    expect(plan.splits.some((s) => s.kind === "RECENT")).toBe(true);
    expect(plan.splits.some((s) => s.kind === "HOLDOUT")).toBe(false);
  });

  it("hashes deterministically", () => {
    expect(splitPlan(charter()).planHash).toBe(splitPlan(charter()).planHash);
  });

  it("reads the frozen walk-forward schedule from the charter", () => {
    expect(walkForwardParamsFromCharter(charter())).toEqual({ windowYears: 3, stepMonths: 12, purgeDays: 21, embargoDays: 5 });
  });

  it("labels the design and recent segments with their charter dates", () => {
    const c = charter();
    expect(designSplit(c).evaluation).toEqual({ start: D(c.boundaries.design.start), end: D(c.boundaries.design.end) });
    expect(recentSplit(c).design).toBeUndefined();
  });

  it("refuses to hand back the holdout window unless the registry opened it", () => {
    const c = charter();
    expect(() => holdoutSplit(c, { opened: false })).toThrow(HoldoutSealedError);
    const opened = holdoutSplit(c, { opened: true });
    expect(opened.kind).toBe("HOLDOUT");
    expect(opened.evaluation.start).toBe(D(c.boundaries.holdout.start));
  });

  it("rejects a charter whose walk-forward schedule would reach into the holdout", () => {
    const c = charter();
    // Move the design period so its walk-forward evaluation windows cross the holdout start.
    const broken: Charter = { ...c, boundaries: { ...c.boundaries, design: { start: "2007-06-01", end: "2019-06-30" } } };
    expect(() => splitPlan(broken)).toThrow(SplitRangeError);
  });
});

describe("independentBlocks", () => {
  it("counts whole non-overlapping blocks only", () => {
    expect(independentBlocks(252, 21)).toBe(12);
    expect(independentBlocks(251, 21)).toBe(11);
    expect(independentBlocks(0, 21)).toBe(0);
    expect(() => independentBlocks(100, 0)).toThrow(SplitRangeError);
  });
});

describe("moments", () => {
  it("computes mean, sample stdev, skew, and excess kurtosis", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(mean(xs)).toBe(3);
    expect(stdev(xs)).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(skewness(xs)).toBeCloseTo(0, 12);
    // A right-skewed sample.
    expect(skewness([1, 1, 1, 1, 10])).toBeGreaterThan(0);
    expect(excessKurtosis([1, 2, 3, 4, 5])).toBeLessThan(0);
  });

  it("degrades safely on tiny or degenerate samples", () => {
    expect(stdev([])).toBe(0);
    expect(stdev([1])).toBe(0);
    expect(skewness([1, 1, 1])).toBe(0);
    expect(excessKurtosis([1, 1, 1, 1])).toBe(0);
    expect(annualizedSharpe([0, 0, 0])).toBe(0);
  });

  it("annualizes a Sharpe ratio by the square root of 252", () => {
    const excess = Array.from({ length: 252 }, (_, i) => (i % 2 === 0 ? 0.002 : -0.001));
    const expected = (mean(excess) / stdev(excess)) * Math.sqrt(252);
    expect(annualizedSharpe(excess)).toBeCloseTo(expected, 12);
  });

  it("interpolates quantiles", () => {
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.25)).toBeCloseTo(2.5, 12);
    expect(() => quantile([1, 2], 1.5)).toThrow(RangeError);
  });
});

describe("seededRandom", () => {
  it("is deterministic for a seed and different across seeds", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const c = seededRandom(43);
    const first = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(first);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(first);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("stationaryBootstrap", () => {
  const dailyDrift = 0.0004;
  const series = Array.from({ length: 500 }, (_, i) => Math.sin(i) / 100 + dailyDrift);

  it("reproduces the same interval for the same seed", () => {
    const opts = { meanBlockSessions: 21, resamples: 300, confidence: 0.9, seed: 5 };
    const a = stationaryBootstrap(series, annualizedSharpe, opts);
    const b = stationaryBootstrap(series, annualizedSharpe, opts);
    expect(a.lower).toBe(b.lower);
    expect(a.upper).toBe(b.upper);
    expect(a.pointEstimate).toBe(annualizedSharpe(series));
  });

  it("brackets the point estimate and reports the distribution diagnostics", () => {
    const r = stationaryBootstrap(series, mean, { meanBlockSessions: 21, resamples: 400, seed: 11 });
    expect(r.lower).toBeLessThanOrEqual(r.upper);
    expect(r.diagnostics.n).toBe(series.length);
    expect(Number.isFinite(r.diagnostics.skewness)).toBe(true);
    expect(Number.isFinite(r.diagnostics.excessKurtosis)).toBe(true);
  });

  it("widens the interval as the block length grows, because dependence is preserved", () => {
    // A strongly autocorrelated series: long blocks keep the runs together and admit more variation.
    const trending = Array.from({ length: 400 }, (_, i) => (i < 200 ? 0.003 : -0.003));
    const short = stationaryBootstrap(trending, mean, { meanBlockSessions: 1, resamples: 500, seed: 3 });
    const long = stationaryBootstrap(trending, mean, { meanBlockSessions: 60, resamples: 500, seed: 3 });
    expect(long.upper - long.lower).toBeGreaterThan(short.upper - short.lower);
  });

  it("reports whether the interval excludes zero", () => {
    const positive = stationaryBootstrap(
      Array.from({ length: 400 }, () => 0.001),
      mean,
      { meanBlockSessions: 21, resamples: 200, seed: 9 },
    );
    expect(positive.excludesZero).toBe(true);
    const noisy = stationaryBootstrap(
      Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.05)),
      mean,
      { meanBlockSessions: 21, resamples: 400, seed: 9 },
    );
    expect(noisy.excludesZero).toBe(false);
  });

  it("rejects malformed inputs", () => {
    expect(() => stationaryBootstrap([1], mean, { meanBlockSessions: 5 })).toThrow(RangeError);
    expect(() => stationaryBootstrap([1, 2], mean, { meanBlockSessions: 0 })).toThrow(RangeError);
    expect(() => stationaryBootstrap([1, 2], mean, { meanBlockSessions: 5, confidence: 1 })).toThrow(RangeError);
  });
});

describe("deflatedSharpe", () => {
  const good = { observedSharpe: 0.9, trialSharpeStdev: 0.3, trials: 72, observations: 3000, skewness: -0.2, excessKurtosis: 3 };

  it("deflates a Sharpe for the declared trial count", () => {
    const r = deflatedSharpe(good);
    expect(r.assumptionsHold).toBe(true);
    expect(r.expectedMaximumSharpe).toBeGreaterThan(0);
    expect(r.deflatedSharpe).toBeGreaterThanOrEqual(0);
    expect(r.deflatedSharpe).toBeLessThanOrEqual(1);
    expect(r.trials).toBe(72);
  });

  it("penalises more trials at the same observed Sharpe", () => {
    const few = deflatedSharpe({ ...good, trials: 4 });
    const many = deflatedSharpe({ ...good, trials: 500 });
    expect(many.expectedMaximumSharpe).toBeGreaterThan(few.expectedMaximumSharpe);
    expect(many.deflatedSharpe).toBeLessThan(few.deflatedSharpe);
  });

  it("refuses to report when the sample is too small, rather than dressing it up", () => {
    const small = deflatedSharpe({ ...good, observations: 30 });
    expect(small.assumptionsHold).toBe(false);
    expect(Number.isNaN(small.deflatedSharpe)).toBe(true);
    expect(small.assumptionNotes.join(" ")).toContain("30 observations");
  });

  it("refuses on one trial, zero dispersion, or extreme kurtosis", () => {
    expect(deflatedSharpe({ ...good, trials: 1 }).assumptionsHold).toBe(false);
    expect(deflatedSharpe({ ...good, trialSharpeStdev: 0 }).assumptionsHold).toBe(false);
    expect(deflatedSharpe({ ...good, excessKurtosis: 50 }).assumptionsHold).toBe(false);
  });
});

describe("concentrationReport", () => {
  it("reports the top-1, top-3 and top-5 shares of excess return", () => {
    const bySecurity = new Map([
      ["A", N("0.50")],
      ["B", N("0.25")],
      ["C", N("0.15")],
      ["D", N("0.07")],
      ["E", N("0.03")],
    ]);
    const r = concentrationReport({ bySecurity, byYear: new Map() });
    expect(r.total.eq(ONE)).toBe(true);
    expect(r.topSecurityShares.top1.eq(N("0.50"))).toBe(true);
    expect(r.topSecurityShares.top3.eq(N("0.90"))).toBe(true);
    expect(r.topSecurityShares.top5.eq(ONE)).toBe(true);
    expect(r.topSecurities).toEqual(["A", "B", "C", "D", "E"]);
    expect(r.concentrated).toBe(true);
  });

  it("flags a single dominant year or episode", () => {
    // Three even contributors keep the top-1 security share (1/3) under the threshold, so only the year
    // and episode dimensions can trip the flag.
    const bySecurity = new Map([
      ["A", N("0.34")],
      ["B", N("0.33")],
      ["C", N("0.33")],
    ]);
    const spread = concentrationReport({ bySecurity, byYear: new Map([["2020", N("0.33")], ["2021", N("0.33")], ["2022", N("0.34")]]) });
    expect(spread.concentrated).toBe(false);
    const oneYear = concentrationReport({ bySecurity, byYear: new Map([["2020", N("0.9")], ["2021", N("0.1")]]) });
    expect(oneYear.bestYear?.year).toBe("2020");
    expect(oneYear.concentrated).toBe(true);
    const episode = concentrationReport({ bySecurity, byYear: new Map(), byEpisode: new Map([["2020-03", N("0.95")]]) });
    expect(episode.bestEpisode?.episode).toBe("2020-03");
    expect(episode.concentrated).toBe(true);
  });

  it("reports zero shares when there is no positive excess to concentrate", () => {
    const r = concentrationReport({ bySecurity: new Map([["A", N("-0.2")], ["B", N("-0.1")]]), byYear: new Map([["2020", N("-0.3")]]) });
    expect(r.total.isNegative()).toBe(true);
    expect(r.topSecurityShares.top1.isZero()).toBe(true);
    expect(r.bestYear).toBeUndefined();
    expect(r.concentrated).toBe(false);
  });
});

describe("regimeLabels", () => {
  it("labels drawdown, recovery, and calm from the benchmark's own path", () => {
    const level = (v: string): Dec => N(v);
    const series = [
      { session: D("2020-01-02"), level: level("100") },
      { session: D("2020-02-03"), level: level("110") },
      { session: D("2020-03-02"), level: level("80") },
      { session: D("2020-06-01"), level: level("100") },
      { session: D("2020-08-03"), level: level("115") },
      { session: D("2020-09-01"), level: level("116") },
    ];
    const labels = regimeLabels(series);
    expect(labels.get(D("2020-01-02"))).toBe("BENCHMARK_CALM");
    expect(labels.get(D("2020-03-02"))).toBe("BENCHMARK_DRAWDOWN");
    expect(labels.get(D("2020-06-01"))).toBe("BENCHMARK_RECOVERY");
    expect(labels.get(D("2020-08-03"))).toBe("BENCHMARK_CALM");
  });

  it("uses the benchmark only, so it can never add a trial to the ledger", () => {
    // The classifier's whole input is the benchmark series: no strategy return reaches it.
    const labels = regimeLabels([
      { session: D("2020-01-02"), level: ONE },
      { session: D("2020-01-03"), level: ZERO.plus(N("0.5")) },
    ]);
    expect(labels.size).toBe(2);
    expect(labels.get(D("2020-01-03"))).toBe("BENCHMARK_DRAWDOWN");
  });
});

describe("normal distribution helpers", () => {
  it("matches published standard normal quantiles", async () => {
    const { normalQuantile } = await import("../src/research/stats.ts");
    // Values from standard tables; Acklam's approximation claims |error| < 1.15e-9.
    const known: [number, number][] = [
      [0.5, 0],
      [0.75, 0.6744897501960817],
      [0.9, 1.2815515655446004],
      [0.95, 1.6448536269514722],
      [0.975, 1.959963984540054],
      [0.99, 2.3263478740408408],
      [0.995, 2.5758293035489004],
      [0.999, 3.0902323061678132],
      [0.01, -2.3263478740408408],
      [0.001, -3.0902323061678132],
    ];
    for (const [p, z] of known) expect(normalQuantile(p)).toBeCloseTo(z, 7);
  });

  it("is symmetric and monotone", async () => {
    const { normalQuantile } = await import("../src/research/stats.ts");
    for (const p of [0.001, 0.02, 0.2, 0.4]) expect(normalQuantile(p)).toBeCloseTo(-normalQuantile(1 - p), 7);
    let previous = -Infinity;
    for (let p = 0.01; p < 1; p += 0.01) {
      const z = normalQuantile(p);
      expect(z).toBeGreaterThan(previous);
      previous = z;
    }
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });

  it("matches published standard normal CDF values", async () => {
    const { normalCdf } = await import("../src/research/stats.ts");
    const known: [number, number][] = [
      [0, 0.5],
      [1, 0.8413447460685429],
      [1.6448536269514722, 0.95],
      [1.959963984540054, 0.975],
      [2.3263478740408408, 0.99],
      [-1, 0.15865525393145707],
      [-2.3263478740408408, 0.01],
    ];
    // The erf approximation is good to about 1.5e-7 absolute.
    for (const [z, p] of known) expect(normalCdf(z)).toBeCloseTo(p, 6);
  });

  it("round-trips the quantile through the CDF", async () => {
    const { normalCdf, normalQuantile } = await import("../src/research/stats.ts");
    for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 6);
  });
});
