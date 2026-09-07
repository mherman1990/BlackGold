import { describe, expect, it } from "vitest";
import { Dec, ONE, ZERO, isoDate, type IsoDate } from "@blackgold/shared";
import { TR_ADJUSTMENT_VERSION, type TRPoint, type TRSeries } from "../src/market/series.ts";
import { blendSeries } from "../src/research/benchmarks.ts";
import { ATTRIBUTION_VERSION, attributionHash, exposureAttribution, factorAttribution, monthlyReturns, ols, RegressionInputError } from "../src/research/attribution.ts";

const N = (s: string): Dec => new Dec(s);
const D = (s: string): IsoDate => isoDate(s);
const TOL = N("1e-18");
const close = (a: Dec, b: Dec): boolean => a.minus(b).abs().lt(TOL);

/** Build a TRSeries from a per-session growth factor list starting at index 1. */
function series(entityId: string, sessions: readonly IsoDate[], growth: (i: number) => Dec): TRSeries {
  const points: TRPoint[] = [];
  let index = ONE;
  sessions.forEach((session, i) => {
    if (i > 0) index = index.times(growth(i));
    points.push({ session, trIndex: index, adjClose: index, distribution: ZERO, terminal: false });
  });
  return { entityId, points, adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings: [] };
}

function businessSessions(count: number, start = "2020-01-01"): IsoDate[] {
  const out: IsoDate[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(D(d.toISOString().slice(0, 10)));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("exposureAttribution", () => {
  const sessions = businessSessions(260);

  it("assigns the whole excess to timing when the strategy just holds less of the same benchmark", () => {
    const benchmark = series("VTI", sessions, () => N("1.0006"));
    const cash = series("BIL", sessions, () => N("1.00008"));
    const weight = N("0.60");
    // The strategy IS the 60/40 blend, so selection must be zero and timing must carry everything.
    const matched = blendSeries({ equity: benchmark, cash, equityWeight: weight });
    const strategy = { ...matched, entityId: "STRATEGY" };
    const r = exposureAttribution({
      strategy,
      benchmark,
      exposureMatched: matched,
      equityWeights: sessions.map((session) => ({ session, weight })),
    });
    expect(close(r.selectionContribution, ZERO)).toBe(true);
    expect(close(r.timingContribution, r.totalExcess.minus(r.compoundingCrossTerm))).toBe(true);
    expect(r.timingContribution.isNegative()).toBe(true); // less equity in a rising market costs return
    expect(close(r.averageEquityWeight, weight)).toBe(true);
    expect(r.attributionVersion).toBe(ATTRIBUTION_VERSION);
  });

  it("assigns the excess to selection when the strategy holds better equity at the same exposure", () => {
    const benchmark = series("VTI", sessions, () => N("1.0004"));
    const cash = series("BIL", sessions, () => N("1.00008"));
    const weight = ONE;
    const matched = blendSeries({ equity: benchmark, cash, equityWeight: weight });
    // Fully invested, but in something that compounds faster than the benchmark.
    const strategy = series("STRATEGY", sessions, () => N("1.0008"));
    const r = exposureAttribution({ strategy, benchmark, exposureMatched: matched, equityWeights: sessions.map((session) => ({ session, weight })) });
    expect(r.selectionContribution.gt(0)).toBe(true);
    expect(close(r.timingContribution, ZERO)).toBe(true);
    expect(r.totalExcess.gt(0)).toBe(true);
  });

  it("splits a strategy that both times and selects into both components", () => {
    const benchmark = series("VTI", sessions, () => N("1.0004"));
    const cash = series("BIL", sessions, () => N("1.00008"));
    const weight = N("0.50");
    const matched = blendSeries({ equity: benchmark, cash, equityWeight: weight });
    const strategy = series("STRATEGY", sessions, () => N("1.0005"));
    const r = exposureAttribution({ strategy, benchmark, exposureMatched: matched, equityWeights: sessions.map((session) => ({ session, weight })) });
    expect(r.timingContribution.isZero()).toBe(false);
    expect(r.selectionContribution.isZero()).toBe(false);
    // The two components plus the compounding cross term reconstruct the total exactly.
    expect(close(r.timingContribution.plus(r.selectionContribution).plus(r.compoundingCrossTerm), r.totalExcess)).toBe(true);
  });

  it("restricts to common sessions so a late-starting series cannot inflate a component", () => {
    const benchmark = series("VTI", sessions, () => N("1.0004"));
    const cash = series("BIL", sessions, () => N("1.00008"));
    const matched = blendSeries({ equity: benchmark, cash, equityWeight: ONE });
    const late = series("STRATEGY", sessions.slice(200), () => N("1.0004"));
    const r = exposureAttribution({ strategy: late, benchmark, exposureMatched: matched, equityWeights: [] });
    expect(r.sessions).toBe(sessions.slice(200).length);
    expect(r.averageEquityWeight.isZero()).toBe(true);
  });
});

describe("ols", () => {
  it("recovers known coefficients from a noiseless design", () => {
    // Named so the repository's float-literal rule (no inline decimals in arithmetic) is satisfied.
    const trueAlpha = 0.5;
    const beta1 = 2;
    const beta2 = -3;
    const x1 = Array.from({ length: 60 }, (_, i) => i / 60);
    const x2 = Array.from({ length: 60 }, (_, i) => Math.sin(i));
    const y = x1.map((v, i) => trueAlpha + beta1 * v + beta2 * (x2[i] ?? 0));
    const r = ols(y, [
      { name: "F1", values: x1 },
      { name: "F2", values: x2 },
    ]);
    expect(r.alpha).toBeCloseTo(trueAlpha, 8);
    expect(r.coefficients[1]).toBeCloseTo(beta1, 8);
    expect(r.coefficients[2]).toBeCloseTo(beta2, 8);
    expect(r.rSquared).toBeCloseTo(1, 8);
    expect(r.degenerateFit).toBe(true);
    expect(r.observations).toBe(60);
    expect(r.factorNames).toEqual(["F1", "F2"]);
  });

  it("reports standard errors and t statistics that grow with noise", () => {
    const x = Array.from({ length: 120 }, (_, i) => Math.cos(i));
    const quiet = ols(
      x.map((v, i) => 2 * v + (i % 3) / 100),
      [{ name: "F", values: x }],
    );
    const noisy = ols(
      x.map((v, i) => 2 * v + (i % 7) - 3),
      [{ name: "F", values: x }],
    );
    expect(quiet.degenerateFit).toBe(false);
    expect(noisy.degenerateFit).toBe(false);
    expect(quiet.standardErrors[1] ?? 1).toBeLessThan(noisy.standardErrors[1] ?? 0);
    expect(Math.abs(quiet.tStatistics[1] ?? 0)).toBeGreaterThan(Math.abs(noisy.tStatistics[1] ?? 0));
    expect(quiet.adjustedRSquared).toBeGreaterThan(noisy.adjustedRSquared);
  });

  it("flags an exactly fitting design instead of reporting a t statistic of zero", () => {
    const x = Array.from({ length: 120 }, (_, i) => Math.cos(i));
    const exact = ols(
      x.map((v) => 2 * v),
      [{ name: "F", values: x }],
    );
    expect(exact.degenerateFit).toBe(true);
    expect(exact.coefficients[1]).toBeCloseTo(2, 8);
    expect(exact.standardErrors[1]).toBe(0);
    // The t statistic is undefined here; the flag is what a report must read, not the zero.
    expect(exact.tStatistics[1]).toBe(0);
  });

  it("refuses a sample too small to estimate its own residual variance", () => {
    expect(() => ols([1, 2], [{ name: "F", values: [1, 2] }])).toThrow(RegressionInputError);
  });

  it("refuses collinear factors instead of returning a fitted-looking result", () => {
    const x = Array.from({ length: 50 }, (_, i) => i);
    expect(() =>
      ols(
        x.map((v) => v + 1),
        [
          { name: "F", values: x },
          { name: "F_DOUBLE", values: x.map((v) => 2 * v) },
        ],
      ),
    ).toThrow(RegressionInputError);
  });

  it("rejects a factor of the wrong length", () => {
    expect(() => ols([1, 2, 3, 4, 5], [{ name: "F", values: [1, 2] }])).toThrow(RegressionInputError);
  });
});

describe("monthlyReturns", () => {
  it("compounds daily returns into calendar months, ascending", () => {
    const sessions = businessSessions(80);
    const s = series("X", sessions, () => N("1.001"));
    const months = monthlyReturns(s.points);
    expect(months.length).toBeGreaterThan(2);
    expect(months.map((m) => m.month)).toEqual([...months.map((m) => m.month)].sort());
    for (const m of months) expect(m.value.gt(0)).toBe(true);
  });
});

describe("factorAttribution", () => {
  const sessions = businessSessions(900);
  const benchmark = series("VTI", sessions, () => N("1.0004"));

  it("says plainly that attribution was not performed with no factor library", () => {
    const strategy = series("S", sessions, () => N("1.0005"));
    const r = factorAttribution({ strategy, benchmark, factors: [] });
    expect(r.regression).toBeUndefined();
    expect(r.notPerformedReason).toContain("no factor library");
  });

  it("refuses when too few months are covered by every factor series", () => {
    const strategy = series("S", sessions, () => N("1.0005"));
    const months = monthlyReturns(strategy.points).slice(0, 6);
    const r = factorAttribution({
      strategy,
      benchmark,
      factors: [{ name: "MKT", monthly: new Map(months.map((m) => [m.month, m.value])) }],
    });
    expect(r.regression).toBeUndefined();
    expect(r.notPerformedReason).toContain("factor attribution was not performed");
    expect(r.months).toBe(6);
  });

  it("runs the regression and bootstraps the intercept when the data support it", () => {
    const strategy = series("S", sessions, (i) => (i % 3 === 0 ? N("1.0012") : N("1.0002")));
    const excessMonths = monthlyReturns(strategy.points);
    // A factor that is deliberately unrelated to the excess: the intercept should carry the mean.
    const factor = new Map(excessMonths.map((m, i) => [m.month, N(i % 2 === 0 ? "0.01" : "-0.01")]));
    const r = factorAttribution({ strategy, benchmark, factors: [{ name: "MKT", monthly: factor }], seed: 3 });
    expect(r.notPerformedReason).toBeUndefined();
    expect(r.regression).toBeDefined();
    expect(r.months).toBeGreaterThanOrEqual(24);
    expect(r.alphaInterval).toBeDefined();
    if (r.alphaInterval && r.regression) {
      expect(r.alphaInterval.lower).toBeLessThanOrEqual(r.regression.alpha);
      expect(r.alphaInterval.upper).toBeGreaterThanOrEqual(r.regression.alpha);
      expect(r.alphaInterval.confidence).toBe(0.9);
    }
  });

  it("reproduces the same alpha interval for the same seed", () => {
    const strategy = series("S", sessions, (i) => (i % 3 === 0 ? N("1.0012") : N("1.0002")));
    const factor = new Map(monthlyReturns(strategy.points).map((m, i) => [m.month, N(i % 2 === 0 ? "0.01" : "-0.01")]));
    const args = { strategy, benchmark, factors: [{ name: "MKT", monthly: factor }], seed: 21 };
    expect(factorAttribution(args).alphaInterval).toEqual(factorAttribution(args).alphaInterval);
  });

  it("reports a collinear factor set as not performed rather than throwing", () => {
    const strategy = series("S", sessions, () => N("1.0005"));
    const months = monthlyReturns(strategy.points);
    const a = new Map(months.map((m, i) => [m.month, N(String(i))]));
    const b = new Map(months.map((m, i) => [m.month, N(String(i * 2))]));
    const r = factorAttribution({ strategy, benchmark, factors: [{ name: "A", monthly: a }, { name: "B", monthly: b }] });
    expect(r.regression).toBeUndefined();
    expect(r.notPerformedReason).toContain("collinear");
  });
});

describe("attributionHash", () => {
  it("is stable and content addressed", () => {
    expect(attributionHash({ a: 1 })).toBe(attributionHash({ a: 1 }));
    expect(attributionHash({ a: 1 })).not.toBe(attributionHash({ a: 2 }));
    expect(attributionHash({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
