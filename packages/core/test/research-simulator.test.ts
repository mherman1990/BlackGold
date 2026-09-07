import { describe, expect, it } from "vitest";
import { Dec, dec, isoDate } from "@blackgold/shared";
import { DecisionSessionNotFoundError, participationCap, simulateFill, type CostModel, type SimBar } from "../src/index.ts";

const d = isoDate;
const D = (s: string): Dec => new Dec(s);

function bar(session: string, open: string, close: string, volume: bigint, tradable = true): SimBar {
  return { symbol: "TST", session: d(session), open: D(open), high: D(close).plus(2), low: D(open).minus(2), close: D(close), volume, venue: "iex", tradable };
}

const BARS: SimBar[] = [
  bar("2026-03-02", "100", "100", 100_000n),
  bar("2026-03-03", "101", "102", 100_000n),
  bar("2026-03-04", "103", "104", 1_000n), // thin: 2% participation = 20 shares
  bar("2026-03-05", "105", "105", 100_000n, false), // STALE_BAR: no trading
  bar("2026-03-06", "106", "107", 100_000n),
  bar("2026-03-09", "108", "109", 100_000n),
];
const COSTS: CostModel = { commissionBps: D("0"), halfSpreadBps: D("2"), slippageBps: D("3") };

describe("simulateFill", () => {
  it("fills at the next open, adverse by half-spread + slippage bps for the side, and reports shortfall", () => {
    const buy = simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(500) }, bars: BARS, decisionSession: d("2026-03-02"), costs: COSTS });
    expect(buy.fills).toHaveLength(1);
    expect(buy.fills[0]?.session).toBe("2026-03-03");
    expect(buy.fills[0]?.referencePrice.toFixed()).toBe("101");
    expect(buy.fills[0]?.price.toFixed()).toBe("101.0505"); // 101 x (1 + 5 bps)
    expect(buy.fills[0]?.fees.toFixed()).toBe("0");
    expect(buy.filledQuantity.toFixed()).toBe("500");
    expect(buy.unfilledQuantity.isZero()).toBe(true);
    expect(buy.decisionClose.toFixed()).toBe("100");
    expect(buy.executionShortfall.toFixed()).toBe("525.25"); // (101.0505 - 100) x 500
    expect(buy.executionShortfallBps.toFixed()).toBe("105.05");
    expect(buy.labels).toEqual([]);

    const sell = simulateFill({ intent: { entityId: "TST", side: "SELL", quantity: dec(500) }, bars: BARS, decisionSession: d("2026-03-02"), costs: COSTS });
    expect(sell.fills[0]?.price.toFixed()).toBe("100.9495"); // 101 x (1 - 5 bps)
    expect(sell.executionShortfall.toFixed()).toBe("-474.75"); // sold above the decision close: negative shortfall
  });

  it("caps at participation, carries the remainder, and skips stale bars", () => {
    const res = simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(500) }, bars: BARS, decisionSession: d("2026-03-03"), costs: COSTS });
    expect(res.fills.map((f) => [f.session, f.quantity.toFixed()])).toEqual([
      ["2026-03-04", "20"],
      ["2026-03-06", "480"],
    ]);
    expect(res.skippedSessions).toEqual(["2026-03-05"]);
    expect(res.fills[1]?.price.toFixed()).toBe("106.053");
    expect(res.filledQuantity.toFixed()).toBe("500");
    expect(participationCap(1_000n, D("0.02")).toFixed()).toBe("20");
    expect(participationCap(1_049n, D("0.02")).toFixed()).toBe("20"); // whole shares
    const limited = simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(500) }, bars: BARS, decisionSession: d("2026-03-03"), costs: COSTS, maxFillBars: 1 });
    expect(limited.filledQuantity.toFixed()).toBe("20");
    expect(limited.unfilledQuantity.toFixed()).toBe("480");
    const wide = simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(500) }, bars: BARS, decisionSession: d("2026-03-03"), costs: COSTS, maxParticipation: D("1") });
    expect(wide.fills).toHaveLength(1);
    expect(wide.fills[0]?.quantity.toFixed()).toBe("500");
  });

  it("honours delayBars, labels a zero delay OPTIMISTIC_DELAY, and charges commission on notional", () => {
    const two = simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(10) }, bars: BARS, decisionSession: d("2026-03-02"), costs: COSTS, delayBars: 2 });
    expect(two.fills[0]?.session).toBe("2026-03-04");
    const zero = simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(10) }, bars: BARS, decisionSession: d("2026-03-02"), costs: COSTS, delayBars: 0 });
    expect(zero.fills[0]?.session).toBe("2026-03-02");
    expect(zero.fills[0]?.referencePrice.toFixed()).toBe("100"); // the decision close, not the same day's open
    expect(zero.labels).toEqual(["OPTIMISTIC_DELAY"]);
    const commission = simulateFill({
      intent: { entityId: "TST", side: "BUY", quantity: dec(100) },
      bars: BARS,
      decisionSession: d("2026-03-02"),
      costs: { commissionBps: D("1"), halfSpreadBps: D("0"), slippageBps: D("0") },
    });
    expect(commission.fills[0]?.price.toFixed()).toBe("101");
    expect(commission.fills[0]?.fees.toFixed()).toBe("1.01"); // 10100 x 1 bps
    expect(commission.executionShortfall.toFixed()).toBe("101.01"); // 100 x (101 - 100) + 1.01
    // Deterministic: identical inputs, identical output.
    const again = simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(500) }, bars: BARS, decisionSession: d("2026-03-03"), costs: COSTS });
    expect(JSON.stringify(again)).toBe(JSON.stringify(simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(500) }, bars: BARS, decisionSession: d("2026-03-03"), costs: COSTS })));
  });

  it("nothing fills after the series ends; bad inputs throw", () => {
    const end = simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(10) }, bars: BARS, decisionSession: d("2026-03-09"), costs: COSTS });
    expect(end.fills).toEqual([]);
    expect(end.unfilledQuantity.toFixed()).toBe("10");
    expect(end.executionShortfall.isZero()).toBe(true);
    expect(end.executionShortfallBps.isZero()).toBe(true);
    expect(() => simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(10) }, bars: BARS, decisionSession: d("2026-03-01"), costs: COSTS })).toThrow(DecisionSessionNotFoundError);
    expect(() => simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(0) }, bars: BARS, decisionSession: d("2026-03-02"), costs: COSTS })).toThrow(RangeError);
    expect(() => simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(1) }, bars: BARS, decisionSession: d("2026-03-02"), costs: COSTS, delayBars: -1 })).toThrow(RangeError);
    expect(() => simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(1) }, bars: BARS, decisionSession: d("2026-03-02"), costs: { ...COSTS, slippageBps: D("-1") } })).toThrow(RangeError);
    expect(() => simulateFill({ intent: { entityId: "TST", side: "BUY", quantity: dec(1) }, bars: [BARS[1], BARS[0]] as SimBar[], decisionSession: d("2026-03-02"), costs: COSTS })).toThrow(
      /session-ordered/,
    );
  });
});
