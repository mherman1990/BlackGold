import { describe, expect, it } from "vitest";
import { Dec, dec, isoDate } from "@blackgold/shared";
import {
  BenchmarkUnavailableError,
  annualTurnover,
  annualizedVol,
  benchmarkSeries,
  blendSeries,
  volatilityTargetedSeries,
  type VolTargetActivation,
  type VolTargetLeg,
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

describe("volatilityTargetedSeries (ALPHA_CHARTER section 11 Secondary 2)", () => {
  const S = (n: number): ReturnType<typeof isoDate> => isoDate(`2026-01-${String(n).padStart(2, "0")}`);
  const atOpen = (w: string, day: number): VolTargetActivation => ({ weight: dec(w), acquiredAt: { kind: "open", session: S(day) } });
  const atClose = (w: string, day: number): VolTargetActivation => ({ weight: dec(w), acquiredAt: { kind: "close", session: S(day) } });

  /** A leg from explicit `[day, open, close, distribution?]` rows. No splits. */
  function leg(rows: readonly (readonly [number, number, number] | readonly [number, number, number, number])[]): VolTargetLeg {
    const bars = rows.map(([day, open, close]) => ({
      session: S(day),
      symbol: "X",
      open: dec(String(open)),
      high: dec(String(Math.max(open, close))),
      low: dec(String(Math.min(open, close))),
      close: dec(String(close)),
      volume: 1000n,
      venue: "test",
    }));
    let tr = dec("1");
    const points = bars.map((b, i) => {
      const prev = bars[i - 1];
      const distribution = dec(String(rows[i]?.[3] ?? 0));
      if (prev !== undefined) tr = tr.times(b.close.plus(distribution)).div(prev.close);
      return { session: b.session, trIndex: tr, adjClose: b.close, distribution, terminal: false };
    });
    return { bars, tr: { entityId: "X", points, adjustmentVersion: "test", warnings: [] } };
  }

  // Equity gaps UP 10% overnight on day 2, then is flat intraday; day 3 is flat throughout.
  // A weight acquired at day 2's OPEN must not earn that gap; one acquired at day 1's CLOSE must.
  const equity = leg([[1, 100, 100], [2, 110, 110], [3, 110, 110]]);
  const cash = leg([[1, 10, 10], [2, 10, 10], [3, 10, 10]]);

  it("gives a pre-fill gap to the OLD weight, not the newly acquired one", () => {
    const s = volatilityTargetedSeries({ equity, cash, activations: [atOpen("1", 2)] });
    // Day 2: overnight earned at weight 0 (flat cash) => +0%. Intraday at weight 1 => open 110 -> close 110 => +0%.
    // So the index is unchanged on day 2 despite the equity leg gaining 10%.
    expect(s.series.points[1]?.trIndex.toFixed(8)).toBe(dec("1").toFixed(8));
    expect(s.exact).toBe(true);
    expect(s.inexactReasons).toEqual([]);
  });

  it("earns the gap when the weight was acquired at the prior close", () => {
    // `execution_delay_bars === 0`: `simulateFill` fills at the decision close, so the position DOES exist for
    // the following overnight leg. Nothing is split - the new weight holds the whole step.
    const s = volatilityTargetedSeries({ equity, cash, activations: [atClose("1", 1)] });
    expect(s.series.points[1]?.trIndex.toFixed(8)).toBe(dec("1.1").toFixed(8));
    expect(s.exact).toBe(true);
  });

  it("earns NONE of the step ending at the close it was acquired on", () => {
    // The look-ahead invariant, now structural rather than clamped: a weight acquired at day 2's close was set
    // by data through that close, so it must earn nothing of the day-1-to-day-2 move and everything after.
    const rising = leg([[1, 100, 100], [2, 110, 110], [3, 110, 121]]);
    const s = volatilityTargetedSeries({ equity: rising, cash, activations: [atClose("1", 2)] });
    expect(s.series.points[1]?.trIndex.toFixed(8)).toBe(dec("1").toFixed(8));
    expect(s.series.points[2]?.trIndex.toFixed(8)).toBe(dec("1.1").toFixed(8));
    expect(s.exact).toBe(true);
  });

  it("earns the intraday move at the NEW weight", () => {
    const intraday = leg([[1, 100, 100], [2, 100, 110], [3, 110, 110]]);
    const s = volatilityTargetedSeries({ equity: intraday, cash, activations: [atOpen("1", 2)] });
    expect(s.series.points[1]?.trIndex.toFixed(8)).toBe(dec("1.1").toFixed(8));
    expect(s.exact).toBe(true);
  });

  it("leaves an ex-date distribution with the overnight holder", () => {
    // Day 2 goes ex a 2.00 distribution on a 100.00 close: the full-day total return is +2%, all of it
    // overnight. A buyer at day 2's open has no claim to it.
    const exDate = leg([[1, 100, 100], [2, 100, 100, 2], [3, 100, 100]]);
    const bought = volatilityTargetedSeries({ equity: exDate, cash, activations: [atOpen("1", 2)] });
    expect(bought.series.points[1]?.trIndex.toFixed(8)).toBe(dec("1").toFixed(8));
    // Held from before the ex-date the distribution IS earned, and the two legs then reproduce the leg's own
    // full-day total-return step exactly.
    const held = volatilityTargetedSeries({ equity: exDate, cash, activations: [atOpen("1", 1)] });
    expect(held.series.points[1]?.trIndex.toFixed(8)).toBe(dec("1.02").toFixed(8));
    expect(held.series.points[1]?.trIndex.toFixed(8)).toBe(exDate.tr.points[1]?.trIndex.toFixed(8));
  });

  it("declares itself inexact when the open cannot be split", () => {
    const noOpen = leg([[1, 100, 100], [2, 0, 110], [3, 110, 110]]);
    const s = volatilityTargetedSeries({ equity: noOpen, cash, activations: [atOpen("1", 2)] });
    expect(s.exact).toBe(false);
    expect(s.inexactReasons.join(" ")).toContain("no usable open on 2026-01-02");
    expect(s.series.warnings.join(" ")).toContain("no usable open");
  });

  it("declares itself inexact when the acquisition falls inside a return interval", () => {
    // Cash observes no day 2, so the legs share only days 1 and 3. A fill at day 2's open is inside the
    // day-1-to-day-3 interval and there is no price to split it at. Guessing a side would bias the decisive
    // comparator in a direction that depends on the gap's sign, so the index says so instead.
    const sparseCash = leg([[1, 10, 10], [3, 10, 10]]);
    const s = volatilityTargetedSeries({ equity, cash: sparseCash, activations: [atOpen("1", 2)] });
    expect(s.series.points.map((p) => p.session)).toEqual([S(1), S(3)]);
    expect(s.exact).toBe(false);
    expect(s.inexactReasons.join(" ")).toContain("falls inside the 2026-01-01 -> 2026-01-03 return interval");
  });

  it("declares itself inexact when a rebalance falls past the last shared session", () => {
    const s = volatilityTargetedSeries({ equity, cash, activations: [atOpen("1", 9)] });
    expect(s.series.points[2]?.trIndex.toFixed(8)).toBe(dec("1").toFixed(8));
    expect(s.exact).toBe(false);
    expect(s.inexactReasons.join(" ")).toContain("never applied");
  });

  it("decomposes a session without creating or destroying return", () => {
    // With the weight unchanged across the split, the two legs must multiply back to the plain step.
    const held = volatilityTargetedSeries({ equity, cash, activations: [atOpen("1", 1)] });
    const last = held.series.points[held.series.points.length - 1];
    expect(last?.trIndex.toFixed(8)).toBe(dec("1.1").toFixed(8));
    expect(held.exact).toBe(true);
  });

  it("refuses a weight outside [0, 1], keeping the comparator long-only and unlevered", () => {
    expect(() => volatilityTargetedSeries({ equity, cash, activations: [atOpen("1.5", 2)] })).toThrow(RangeError);
    expect(() => volatilityTargetedSeries({ equity, cash, activations: [atOpen("-0.1", 2)] })).toThrow(RangeError);
  });
});
