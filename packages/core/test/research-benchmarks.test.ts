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
    //
    // Day 2 deliberately has BOTH an overnight gap (100 -> 105) and an intraday move (105 -> 110). Without
    // both, a close instant that wrongly split day 2 would still leave the index at 1 - the old weight would
    // take an all-overnight move and the new weight an empty intraday leg - and this assertion would pass on
    // exactly the look-ahead it exists to catch. A fixture where `open == close` cannot test this at all.
    const rising = leg([[1, 100, 100], [2, 105, 110], [3, 110, 121]]);
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

  it("reports a step that collapses several daily rebalances into one", () => {
    // `commonSessions` silently drops a session one leg lacks, and the resulting step applies the weight once
    // to each leg's COMPOUNDED endpoint return. That is not the daily-rebalanced quantity: at 50% equity,
    // +10% then -9.0909% against flat cash compounds to +0.227% daily and to 0% collapsed. The missing leg is
    // precisely what would be needed to rebuild the intervening steps, so this can only be reported.
    const swings = leg([[1, 100, 100], [2, 110, 110], [3, 100, 100]]);
    const sparseCash = leg([[1, 10, 10], [3, 10, 10]]);
    const half = volatilityTargetedSeries({ equity: swings, cash: sparseCash, activations: [atClose("0.5", 1)] });
    expect(half.series.points.map((q) => q.session)).toEqual([S(1), S(3)]);
    expect(half.exact).toBe(false);
    expect(half.inexactReasons.join(" ")).toContain("skips 1 session(s) one leg observed");
    expect(half.inexactReasons.join(" ")).toContain("collapsing");
    // The number the collapse produces: 0.5 x (100/100 - 1) = 0, against +0.227% for the daily chain.
    expect(half.series.points[1]?.trIndex.toFixed(8)).toBe(dec("1").toFixed(8));
  });

  it("judges the collapse by the PRE-OPEN weight, not the one acquired at the end of it", () => {
    // A stretched interval that ends with a rebalance to exactly 1 was exempted on the strength of the NEW
    // weight. The collapsed stretch is everything before this session's open, and it is priced at the OLD
    // weight - so a collapse that happened entirely at a fractional weight was waved through by the value it
    // rebalanced TO. Secondary 2 targets exactly 1 whenever the primary is below target, so this is the
    // common shape rather than an exotic one.
    const swings = leg([[1, 100, 100], [2, 110, 110], [3, 100, 100]]);
    const sparseCash = leg([[1, 10, 10], [3, 10, 10]]);
    const s = volatilityTargetedSeries({
      equity: swings,
      cash: sparseCash,
      activations: [atClose("0.6", 1), atOpen("1", 3)],
    });
    expect(s.exact).toBe(false);
    expect(s.inexactReasons.join(" ")).toContain("collapsing");
  });

  it("counts a session BOTH legs lack when the expected calendar is supplied", () => {
    // Two stale bars on the same date leave it in neither leg's points, so the union of what the legs
    // observed cannot see it and the step looks ordinary while collapsing two rebalances. Only the run's own
    // calendar reveals it.
    const gapped = leg([[1, 100, 100], [3, 100, 100]]);
    const cashGapped = leg([[1, 10, 10], [3, 10, 10]]);
    const acts = [atClose("0.5", 1)];
    const blind = volatilityTargetedSeries({ equity: gapped, cash: cashGapped, activations: acts });
    expect(blind.exact).toBe(true); // nothing observed day 2, so nothing to notice

    const seeing = volatilityTargetedSeries({
      equity: gapped,
      cash: cashGapped,
      activations: acts,
      expectedSessions: [S(1), S(2), S(3)],
    });
    expect(seeing.exact).toBe(false);
    expect(seeing.inexactReasons.join(" ")).toContain("skips 1 session(s)");
  });

  it("does not flag a collapsed step at a weight of 0 or 1, where compounding is identical", () => {
    // A single-leg blend compounds the same way whether the daily steps are blended or the endpoints are, so
    // the collapse changes nothing and the prong should not be withheld for it. Secondary 2 sits at 1
    // whenever the primary's volatility is below target, which is common.
    const swings = leg([[1, 100, 100], [2, 110, 110], [3, 100, 100]]);
    const sparseCash = leg([[1, 10, 10], [3, 10, 10]]);
    for (const w of ["0", "1"]) {
      const s2 = volatilityTargetedSeries({ equity: swings, cash: sparseCash, activations: [atClose(w, 1)] });
      expect(s2.inexactReasons.join(" ")).not.toContain("collapsing");
    }
  });

  it("decomposes a session without creating or destroying return", () => {
    // With the weight unchanged across the split, the two legs must multiply back to the plain step.
    const held = volatilityTargetedSeries({ equity, cash, activations: [atOpen("1", 1)] });
    const last = held.series.points[held.series.points.length - 1];
    expect(last?.trIndex.toFixed(8)).toBe(dec("1.1").toFixed(8));
    expect(held.exact).toBe(true);
  });

  it("leaves an ex-date rebalance OUT of equity flat, which is what the holder actually experiences", () => {
    // The counterexample that retired the residual form. Day 2 opens at 90, closes at 100 and goes ex 10.00.
    // A holder at weight 1 going to weight 0 at that open sells the share for 90 and keeps the 10, so the
    // portfolio is exactly flat. The residual form - deriving the pre-open leg from the leg's own total-return
    // step - put the holder's income through the NEW allocation's intraday factor and reported -1%.
    const exDate = leg([[1, 100, 100], [2, 90, 100, 10], [3, 100, 100]]);
    const out = volatilityTargetedSeries({
      equity: exDate,
      cash,
      activations: [atClose("1", 1), atOpen("0", 2)],
    });
    expect(out.series.points[1]?.trIndex.toFixed(10)).toBe(dec("1").toFixed(10));
    expect(out.exact).toBe(true);

    // And the open buyer still earns the price move alone - 100/90, no share of the distribution - which is
    // the opposite requirement, and the one the residual form was introduced to satisfy. Both hold now.
    const into = volatilityTargetedSeries({ equity: exDate, cash, activations: [atOpen("1", 2)] });
    expect(into.series.points[1]?.trIndex.toFixed(10)).toBe(dec("100").div(dec("90")).toFixed(10));
  });

  it("reallocates ex-date income at the open, not at the close the leg's index assumes", () => {
    // Both legs the SAME series, so the weights cannot matter and the index tracks that one asset. It does
    // NOT reproduce the asset's own total-return step, and that is correct rather than a defect: the leg's
    // index reinvests its distribution at the CLOSE, while a portfolio being rebalanced at the open holds
    // that income as cash and allocates it AT THE OPEN. Here the holder has 90 of share plus 10 of cash at
    // the open, buys back in at 90, and closes at 100 - so +11.11%, against the index's +10%.
    //
    // The two conventions differ only on a session that is both ex-dividend and a rebalance. Three earlier
    // versions of `legSplit` tried to force them to agree and each broke something else.
    const exDate = leg([[1, 100, 100], [2, 90, 100, 10], [3, 100, 100]]);
    const s = volatilityTargetedSeries({ equity: exDate, cash: exDate, activations: [atOpen("1", 2)] });
    expect(s.series.points[1]?.trIndex.toFixed(10)).toBe(dec("100").div(dec("90")).toFixed(10));
    expect(exDate.tr.points[1]?.trIndex.toFixed(10)).toBe(dec("1.1").toFixed(10));
    expect(s.exact).toBe(true);
  });

  it("counts an ex-date on a session the legs do not share", () => {
    // The equity leg pays on day 2, which the cash leg never observes, so the split spans day 1 to day 3.
    // Reading only `cur.distribution` drops that payment entirely; the income term is a difference of
    // cumulative distributions, so it cannot. The interval is separately reported inexact for collapsing a
    // rebalance, but the VALUE must still be right - a flag is not a substitute for arithmetic.
    const payer = leg([[1, 100, 100], [2, 100, 100, 5], [3, 95, 100]]);
    const noPayer = leg([[1, 100, 100], [2, 100, 100], [3, 95, 100]]);
    const sparseCash = leg([[1, 10, 10], [3, 10, 10]]);
    const acts = [atClose("1", 1), atOpen("0.5", 3)];
    const withDist = volatilityTargetedSeries({ equity: payer, cash: sparseCash, activations: acts });
    const without = volatilityTargetedSeries({ equity: noPayer, cash: sparseCash, activations: acts });
    const a = withDist.series.points[1]?.trIndex;
    const b = without.series.points[1]?.trIndex;
    expect(a?.toFixed(10)).not.toBe(b?.toFixed(10));
    // Held at weight 1 into the split, the 5.00 is earned in full - but as a REINVESTMENT at its own day-2
    // close, not as cash carried to day 3's open. Overnight = (1.05 / 1) x (95 / 100) = 0.9975; then the
    // half-equity intraday leg. Treating it as cash would give 1.0 x the same leg, which is a different
    // number and the defect the carry term exists to prevent.
    const overnight = dec("1.05").div(dec("1")).times(dec("95").div(dec("100")));
    const toClose = dec("0.5").times(dec("100").div(dec("95"))).plus(dec("0.5"));
    expect(a?.toFixed(10)).toBe(overnight.times(toClose).toFixed(10));
  });

  it("compounds an earlier ex-date through its own close, rather than carrying it as cash", () => {
    // The counterexample in its own right, with the numbers chosen so the two treatments are far apart.
    // Equity closes 100 on day 1; day 2 goes ex 10.00 and closes 100; day 3 opens at 200. The index
    // reinvested the 10 at day 2's close, so the position grew 1.1x and then doubled: 2.2. Carrying the 10
    // as cash to day 3's open gives (200 + 10) / 100 = 2.1 - the distribution never participates in the move
    // it was reinvested ahead of.
    const equityLeg = leg([[1, 100, 100], [2, 100, 100, 10], [3, 200, 200]]);
    const sparseCash = leg([[1, 10, 10], [3, 10, 10]]);
    // Weight 1 into the stretch, dropping to 0 at day 3's open. The change is what forces the SPLIT branch -
    // an activation equal to the weight already in force takes the undivided step through `plainStep`, which
    // reads `trIndex` directly and would pass this assertion without ever calling `legSplit`. (The first
    // draft of this test did exactly that.) With the change, the index is the equity leg's overnight factor
    // alone, since the new weight puts the whole intraday leg in flat cash.
    const s = volatilityTargetedSeries({
      equity: equityLeg,
      cash: sparseCash,
      activations: [atClose("1", 1), atOpen("0", 3)],
    });
    expect(s.series.points.map((q) => q.session)).toEqual([S(1), S(3)]);
    expect(s.series.points[1]?.trIndex.toFixed(10)).toBe(dec("2.2").toFixed(10));
    expect(s.series.points[1]?.trIndex.toFixed(10)).not.toBe(dec("2.1").toFixed(10));
  });

  it("refuses a weight outside [0, 1], keeping the comparator long-only and unlevered", () => {
    expect(() => volatilityTargetedSeries({ equity, cash, activations: [atOpen("1.5", 2)] })).toThrow(RangeError);
    expect(() => volatilityTargetedSeries({ equity, cash, activations: [atOpen("-0.1", 2)] })).toThrow(RangeError);
  });
});
