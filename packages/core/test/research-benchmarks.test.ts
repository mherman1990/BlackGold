import { describe, expect, it } from "vitest";
import { Dec, dec, isoDate } from "@blackgold/shared";
import {
  BenchmarkUnavailableError,
  annualTurnover,
  annualizedVol,
  benchmarkSeries,
  blendSeries,
  cagr,
  informationRatio,
  maxDrawdown,
  sharpe,
  type TRPoint,
  type TRSeries,
} from "../src/index.ts";

const d = isoDate;

function series(entityId: string, levels: [string, string][]): TRSeries {
  const points: TRPoint[] = levels.map(([session, idx]) => ({ session: d(session), trIndex: new Dec(idx), adjClose: new Dec(idx), distribution: new Dec(0), terminal: false }));
  return { entityId, points, adjustmentVersion: "tr-1.0.0", warnings: [] };
}

describe("benchmarks", () => {
  it("a 60/40 daily-rebalanced blend reproduces the hand-computed series", () => {
    const equity = series("VTI", [
      ["2026-03-02", "1"],
      ["2026-03-03", "1.10"],
      ["2026-03-04", "0.99"],
    ]);
    const cash = series("BIL", [
      ["2026-03-02", "1"],
      ["2026-03-03", "1.01"],
      ["2026-03-04", "1.0201"],
    ]);
    const blend = blendSeries({ equity, cash, equityWeight: new Dec("0.6") });
    expect(blend.points.map((p) => p.trIndex.toFixed())).toEqual(["1", "1.064", "1.004416"]); // 0.6x0.10 + 0.4x0.01; 0.6x(-0.10) + 0.4x0.01
    expect(blend.entityId).toBe("BLEND(VTI/BIL)");
    // Exposure-matched: the strategy's realized weight held into each session.
    const weights = new Map<string, Dec>([
      ["2026-03-03", new Dec("1")],
      ["2026-03-04", new Dec("0")],
    ]);
    const matched = blendSeries({ equity, cash, equityWeight: (s) => weights.get(s) ?? new Dec(0) });
    expect(matched.points.map((p) => p.trIndex.toFixed())).toEqual(["1", "1.1", "1.111"]); // all-equity day then all-cash day
    expect(() => blendSeries({ equity, cash, equityWeight: new Dec("1.5") })).toThrow(RangeError);
    // Only common sessions are used.
    const shortCash = series("BIL", [
      ["2026-03-03", "1"],
      ["2026-03-04", "1.01"],
    ]);
    expect(blendSeries({ equity, cash: shortCash, equityWeight: new Dec("0.5") }).points.map((p) => p.session)).toEqual(["2026-03-03", "2026-03-04"]);
  });

  it("benchmarkSeries dispatches by kind and fails loudly when a series is missing", () => {
    const vti = series("VTI", [
      ["2026-03-02", "1"],
      ["2026-03-03", "1.01"],
    ]);
    expect(benchmarkSeries("VTI_TR", { VTI_TR: vti })).toBe(vti);
    expect(() => benchmarkSeries("SPY_TR", { VTI_TR: vti })).toThrow(BenchmarkUnavailableError);
    const blend = benchmarkSeries({ blend: { equity: vti, cash: vti, equityWeight: new Dec("0.5") } });
    expect(blend.points[1]?.trIndex.toFixed()).toBe("1.01");
  });

  it("max drawdown on a known path and CAGR over an exact number of years", () => {
    const path = series("S", [
      ["2026-01-02", "1"],
      ["2026-01-05", "1.2"],
      ["2026-01-06", "0.9"],
      ["2026-01-07", "1.0"],
      ["2026-01-08", "0.6"],
      ["2026-01-09", "1.5"],
    ]);
    expect(maxDrawdown(path.points).toFixed()).toBe("-0.5"); // 1.2 -> 0.6
    expect(maxDrawdown(series("U", [["2026-01-02", "1"], ["2026-01-05", "1.1"]]).points).toFixed()).toBe("0");
    // 2022-01-01 -> 2026-01-01 is 1461 days = exactly 4 x 365.25.
    const four = series("G", [
      ["2022-01-01", "1"],
      ["2026-01-01", "1.4641"],
    ]);
    expect(cagr(four.points).toFixed(12)).toBe(new Dec("0.1").toFixed(12));
    const wiped = series("Z", [
      ["2022-01-01", "1"],
      ["2026-01-01", "0"],
    ]);
    expect(cagr(wiped.points).toFixed()).toBe("-1");
    expect(() => cagr(series("one", [["2022-01-01", "1"]]).points)).toThrow(RangeError);
  });

  it("volatility, Sharpe, and information ratio on small hand-checked series", () => {
    const flat = series("F", [
      ["2026-03-02", "1"],
      ["2026-03-03", "1.01"],
      ["2026-03-04", "1.0201"],
    ]);
    expect(annualizedVol(flat.points)).toBeCloseTo(0, 12);
    const strat = series("S", [
      ["2026-03-02", "1"],
      ["2026-03-03", "1.02"],
      ["2026-03-04", "1.02"],
      ["2026-03-05", "1.0302"],
    ]);
    const bench = series("B", [
      ["2026-03-02", "1"],
      ["2026-03-03", "1.01"],
      ["2026-03-04", "1.0201"],
      ["2026-03-05", "1.0201"],
    ]);
    // Active returns: [0.01, -0.01, 0.01]; mean 1/300, sample sd sqrt(2/15000); IR = mean/sd x sqrt(252).
    const expected = (1 / 300 / Math.sqrt(2 / 15000)) * Math.sqrt(252);
    expect(informationRatio(strat.points, bench.points)).toBeCloseTo(expected, 9);
    expect(informationRatio(strat.points, bench.points)).toBeCloseTo(4.5826, 3);
    expect(sharpe(strat.points, bench.points)).toBe(informationRatio(strat.points, bench.points));
    // Constant excess return has zero dispersion: Sharpe is reported as 0 rather than infinity.
    expect(sharpe(flat.points, series("R", [["2026-03-02", "1"], ["2026-03-03", "1"], ["2026-03-04", "1"]]).points)).toBe(0);
    const vol = annualizedVol(strat.points);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeCloseTo(Math.sqrt(252) * Math.sqrt(((Math.log(1.02) - m()) ** 2 + (0 - m()) ** 2 + (Math.log(1.01) - m()) ** 2) / 2), 12);
    function m(): number {
      return (Math.log(1.02) + 0 + Math.log(1.01)) / 3;
    }
  });

  it("annual turnover is traded notional over average NAV per year", () => {
    const t = annualTurnover({ tradedNotional: [dec(50_000), dec(-30_000), dec(20_000)], averageNav: dec(100_000), from: d("2024-01-01"), to: d("2026-01-01") });
    // 100000 / 100000 / (731/365.25) = 0.49965...
    expect(t.toFixed(5)).toBe(new Dec("365.25").div(731).toFixed(5));
    expect(() => annualTurnover({ tradedNotional: [], averageNav: dec(0), from: d("2024-01-01"), to: d("2026-01-01") })).toThrow(RangeError);
  });
});
