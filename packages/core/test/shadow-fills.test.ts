import { describe, expect, it } from "vitest";
import { Dec, isoDate, ONE, ZERO, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ResolvedCosts } from "../src/research/backtest.ts";
import type { ProspectiveDecisionRecord } from "../src/decision/decision-record.ts";
import { dailyNavSeries, type PortfolioEvent } from "../src/research/nav.ts";
import type { SimBar } from "../src/research/simulator.ts";
import { counterfactualFills, fillWindowObserved, SHADOW_SPLIT_ADJUSTED, type ShadowFillRecord, type ShadowSplit } from "../src/decision/shadow-fills.ts";

// Pure fixtures for the PR #102 repairs. Friday 2026-03-06 is the decision session; with one bar of delay the
// first fill attempt is Monday 2026-03-09.
const DECISION: IsoDate = isoDate("2026-03-06");
const DECISION_AT = "2026-03-06T22:00:00.000Z" as UtcInstant;

const bar = (symbol: string, session: string, open: string, close: string, volume = 10_000_000n): SimBar => ({
  symbol,
  session: isoDate(session),
  open: new Dec(open),
  high: Dec.max(new Dec(open), new Dec(close)),
  low: Dec.min(new Dec(open), new Dec(close)),
  close: new Dec(close),
  volume,
  venue: "test",
});

const costs = (delayBars = 1): ResolvedCosts => ({
  tier: "base",
  commissionBps: ZERO,
  halfSpreadBps: { default: new Dec("1") },
  slippageBps: new Dec("1"),
  marketImpactBps: ZERO,
  delayBars,
  maxParticipationOfAdv: new Dec("0.1"),
  costModelVersion: 1,
});

const record = (targets: Record<string, string>, newRiskAllowed = true, haltState: "NORMAL" | "HALT_NEW_RISK" | "HOLD_ONLY" = "NORMAL"): ProspectiveDecisionRecord =>
  ({
    recordVersion: 1,
    strategyId: "etf-trend-vol",
    strategyVersion: "0.2.0",
    charterHash: "sha256:test",
    arm: "B1_DETERMINISTIC",
    mode: "SHADOW",
    policyHashes: {},
    decisionAt: DECISION_AT,
    sealedAt: DECISION_AT,
    snapshotIds: [],
    targetWeights: Object.entries(targets).map(([entityId, weight]) => ({ entityId, weight })),
    cashWeight: "0",
    gate: { newRiskAllowed, haltState, increasedRisk: [], blockedBy: [] },
    constructionVersion: 1,
    notes: [],
  }) as unknown as ProspectiveDecisionRecord;

function fill(opts: {
  targets: Record<string, string>;
  positions?: Record<string, string>;
  cash: string;
  prices: Record<string, string>;
  bars: Record<string, SimBar[]>;
  splits?: ShadowSplit[];
  delayBars?: number;
  gate?: { newRiskAllowed: boolean; haltState: "NORMAL" | "HALT_NEW_RISK" | "HOLD_ONLY" };
}): ShadowFillRecord {
  const positions = new Map(Object.entries(opts.positions ?? {}).map(([k, v]) => [k, new Dec(v)] as const));
  const prices = new Map(Object.entries(opts.prices).map(([k, v]) => [k, new Dec(v)] as const));
  let nav = new Dec(opts.cash);
  for (const [k, q] of positions) nav = nav.plus(q.times(prices.get(k) ?? ZERO));
  return counterfactualFills({
    record: record(opts.targets, opts.gate?.newRiskAllowed ?? true, opts.gate?.haltState ?? "NORMAL"),
    decisionRecordHash: "sha256:sealed",
    decisionSession: DECISION,
    computedAt: "2026-03-20T00:00:00.000Z" as UtcInstant,
    book: { positions, cash: new Dec(opts.cash), nav },
    bars: new Map(Object.entries(opts.bars)),
    prices,
    costs: costs(opts.delayBars),
    bandPctPoints: ZERO,
    ...(opts.splits === undefined ? {} : { splits: opts.splits }),
  });
}

const qty = (r: ShadowFillRecord, entityId: string, side: "BUY" | "SELL"): Dec =>
  r.fills.filter((f) => f.entityId === entityId && f.side === side).reduce((acc, f) => acc.plus(new Dec(f.quantity)), ZERO);

describe("counterfactualFills: rotation and shortfall (Codex, PR #102 round 2)", () => {
  // The book holds only XLV and rotates 100% into QQQ. QQQ sorts BEFORE XLV, so applying orders in entity-id
  // order would try the buy with zero cash and skip it, even though the same-session sale funds it.
  const rotation = () =>
    fill({
      targets: { QQQ: "1" },
      positions: { XLV: "400" },
      cash: "0",
      prices: { QQQ: "200", XLV: "100" },
      bars: {
        QQQ: [bar("QQQ", "2026-03-06", "200", "200"), bar("QQQ", "2026-03-09", "200", "201")],
        XLV: [bar("XLV", "2026-03-06", "100", "100"), bar("XLV", "2026-03-09", "100", "99")],
      },
    });

  it("applies same-session sales before buys, so a rotation funds its entry from its own exit (P1)", () => {
    const r = rotation();
    expect(qty(r, "XLV", "SELL").toFixed()).toBe("400");
    // 200 shares sized at the decision close; the adverse open leaves the last share unaffordable: 199 fill,
    // and the one-share shortfall is the book's own arithmetic (CASH), not a missed entry.
    expect(qty(r, "QQQ", "BUY").toFixed()).toBe("199");
    expect(r.unfilled).toEqual([{ entityId: "QQQ", side: "BUY", remaining: "1", reason: "CASH" }]);
    // The persisted fills are in application order: the sale precedes the buy it funds.
    expect(r.fills.map((f) => f.side)).toEqual(["SELL", "BUY"]);
  });

  it("derives executionShortfall from the fills actually persisted, not the simulator's unclamped quantity (P2)", () => {
    const r = rotation();
    const decisionClose: Record<string, Dec> = { QQQ: new Dec("200"), XLV: new Dec("100") };
    let expected = ZERO;
    for (const f of r.fills) {
      const sign = f.side === "BUY" ? ONE : ONE.negated();
      expected = expected.plus(sign.times(new Dec(f.price).minus(decisionClose[f.entityId] ?? ZERO)).times(new Dec(f.quantity))).plus(new Dec(f.fees));
    }
    expect(r.executionShortfall).toBe(expected.toFixed());
    // The fixture exercises the clamp: the simulator worked 200 QQQ, the record persists 199.
    expect(qty(r, "QQQ", "BUY").lt(200)).toBe(true);
  });
});

describe("counterfactualFills: zero-delay anchor (Codex P2, PR #102 round 3)", () => {
  it("refuses to fill a zero-delay order on a bar older than the decision session", () => {
    // No QQQ bar on Friday 03-06: the zero-delay branch fills at the anchor's CLOSE, so an older anchor would
    // persist a Thursday fill for a Friday decision.
    const r = fill({
      targets: { QQQ: "0.5" },
      cash: "10000",
      prices: { QQQ: "200" },
      bars: { QQQ: [bar("QQQ", "2026-03-05", "199", "200"), bar("QQQ", "2026-03-09", "201", "202")] },
      delayBars: 0,
    });
    expect(r.fills).toEqual([]);
    expect(r.unfilled).toEqual([{ entityId: "QQQ", side: "BUY", remaining: "25", reason: "NO_BARS" }]);
  });

  it("still fills a zero-delay order at the decision session's own close when that bar exists (control)", () => {
    const r = fill({
      targets: { QQQ: "0.5" },
      cash: "10000",
      prices: { QQQ: "200" },
      bars: { QQQ: [bar("QQQ", "2026-03-06", "199", "200"), bar("QQQ", "2026-03-09", "201", "202")] },
      delayBars: 0,
    });
    expect(r.fills.map((f) => f.session)).toEqual(["2026-03-06"]);
    expect(qty(r, "QQQ", "BUY").toFixed()).toBe("25");
  });
});

describe("counterfactualFills: splits between the decision and a delayed fill (Codex P1, PR #102 round 3)", () => {
  it("sells a reverse-split holding in post-split units, and the replay applies the outcome without throwing", () => {
    // 100 XLV held at 100; a 1-for-2 reverse split (ratio 0.5) goes ex on Monday, the fill session. The raw
    // Monday bar is in post-split units (open 200). The exit must sell the 50 post-split shares the replay
    // will hold - selling 100 would throw InsufficientQuantityError in the replay and roll back every run.
    const split: ShadowSplit = { entityId: "XLV", ratio: new Dec("0.5"), exDate: isoDate("2026-03-09") };
    const r = fill({
      targets: {},
      positions: { XLV: "100" },
      cash: "0",
      prices: { XLV: "100" },
      bars: { XLV: [bar("XLV", "2026-03-06", "100", "100"), bar("XLV", "2026-03-09", "200", "200", 5_000_000n)] },
      splits: [split],
    });
    expect(qty(r, "XLV", "SELL").toFixed()).toBe("50");
    expect(r.unfilled).toEqual([]);
    expect(r.labels).toContain(SHADOW_SPLIT_ADJUSTED);
    // Proceeds ~ 50 x 200, not 100 x 200: the exit realizes what the holding is worth, not double.
    const proceeds = r.fills.reduce((acc, f) => acc.plus(new Dec(f.price).times(new Dec(f.quantity))), ZERO);
    expect(proceeds.gt(new Dec("9990")) && proceeds.lt(new Dec("10001"))).toBe(true);

    // The NAV replay - split before the same-day fill - must accept the persisted outcome.
    const events: PortfolioEvent[] = [
      { type: "FILL", entityId: "XLV", side: "BUY", quantity: new Dec("100"), price: new Dec("100"), fees: ZERO, session: isoDate("2026-03-05") },
      { type: "SPLIT", entityId: "XLV", ratio: split.ratio, exDate: split.exDate },
      ...r.fills.map((f) => ({ type: "FILL" as const, entityId: f.entityId, side: f.side, quantity: new Dec(f.quantity), price: new Dec(f.price), fees: new Dec(f.fees), session: f.session })),
    ];
    const replay = dailyNavSeries({
      initialCash: new Dec("10000"),
      events,
      sessions: [isoDate("2026-03-05"), isoDate("2026-03-06"), isoDate("2026-03-09")],
      closes: (s) => new Map([["XLV", new Dec(s === "2026-03-09" ? "200" : "100")]]),
    });
    expect(replay.portfolio.positions.get("XLV")?.quantity.isZero() ?? true).toBe(true);
  });

  it("buys a forward-split target in post-split units instead of underfilling it by the split ratio", () => {
    // Sized at Friday's 200 close: 50 shares. A 2-for-1 split goes ex Monday (open 100). The target is ~10000
    // of QQQ, i.e. ~100 post-split shares; working 50 against post-split bars would buy half the target.
    const r = fill({
      targets: { QQQ: "1" },
      cash: "10000",
      prices: { QQQ: "200" },
      bars: { QQQ: [bar("QQQ", "2026-03-06", "200", "200"), bar("QQQ", "2026-03-09", "100", "100")] },
      splits: [{ entityId: "QQQ", ratio: new Dec("2"), exDate: isoDate("2026-03-09") }],
    });
    // 100 post-split shares at the adverse open cost a hair over 10000: 99 fill, and the half decision-unit
    // share left is CASH arithmetic.
    expect(qty(r, "QQQ", "BUY").toFixed()).toBe("99");
    expect(r.unfilled).toEqual([{ entityId: "QQQ", side: "BUY", remaining: "0.5", reason: "CASH" }]);
    expect(r.labels).toContain(SHADOW_SPLIT_ADJUSTED);
  });

  it("exits a forward-split holding in full: the held quantity is split-adjusted before the same-day sale", () => {
    // 100 QQQ held; a 2-for-1 split goes ex Monday. The replay will hold 200 post-split shares, and the exit
    // must sell all 200 - clamping to the unadjusted 100 would leave half the position behind.
    const r = fill({
      targets: {},
      positions: { QQQ: "100" },
      cash: "0",
      prices: { QQQ: "200" },
      bars: { QQQ: [bar("QQQ", "2026-03-06", "200", "200"), bar("QQQ", "2026-03-09", "100", "100")] },
      splits: [{ entityId: "QQQ", ratio: new Dec("2"), exDate: isoDate("2026-03-09") }],
    });
    expect(qty(r, "QQQ", "SELL").toFixed()).toBe("200");
    expect(r.unfilled).toEqual([]);
  });

  it("ignores a split dated on or before the decision session (the replayed book is already in its units)", () => {
    const r = fill({
      targets: { QQQ: "1" },
      cash: "10000",
      prices: { QQQ: "200" },
      bars: { QQQ: [bar("QQQ", "2026-03-06", "200", "200"), bar("QQQ", "2026-03-09", "200", "200")] },
      splits: [{ entityId: "QQQ", ratio: new Dec("2"), exDate: DECISION }],
    });
    expect(qty(r, "QQQ", "BUY").toFixed()).toBe("49");
    expect(r.labels).not.toContain(SHADOW_SPLIT_ADJUSTED);
  });
});

describe("fillWindowObserved: completion counted in the entity's own bars (Codex P1, PR #102 round 3)", () => {
  const sessions = (list: string[]): SimBar[] => list.map((s) => bar("VTI", s, "200", "200"));

  it("waits past the calendar window end when the entity is missing a session inside the window", () => {
    // Delay 1 + 5 bars from Friday 03-06: the calendar says the window ends Friday 03-13. With Wednesday 03-11
    // missing, the simulator's fifth bar is Monday 03-16 - finalizing on 03-13 would seal a remainder one more
    // bar could still work.
    const withGap = sessions(["2026-03-06", "2026-03-09", "2026-03-10", "2026-03-12", "2026-03-13"]);
    expect(fillWindowObserved(withGap, DECISION, 1, 5)).toBe(false);
    expect(fillWindowObserved([...withGap, ...sessions(["2026-03-16"])], DECISION, 1, 5)).toBe(true);
    // Control: no gap - complete exactly at the calendar window end.
    expect(fillWindowObserved(sessions(["2026-03-06", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13"]), DECISION, 1, 5)).toBe(true);
  });

  it("counts the zero-delay decision-bar attempt before the loop, and never completes without an anchor", () => {
    const full = sessions(["2026-03-06", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12"]);
    expect(fillWindowObserved(full, DECISION, 0, 5)).toBe(false); // the loop's fifth bar is 03-13
    expect(fillWindowObserved([...full, ...sessions(["2026-03-13"])], DECISION, 0, 5)).toBe(true);
    expect(fillWindowObserved(sessions(["2026-03-05", "2026-03-09"]), DECISION, 0, 5)).toBe(false); // no Friday bar at zero delay
    expect(fillWindowObserved(undefined, DECISION, 1, 5)).toBe(false);
  });
});

describe("counterfactualFills: halt verdicts bind the fills (D-54)", () => {
  const rotationUnder = (gate: { newRiskAllowed: boolean; haltState: "NORMAL" | "HALT_NEW_RISK" | "HOLD_ONLY" }) =>
    fill({
      targets: { QQQ: "1" },
      positions: { XLV: "400" },
      cash: "0",
      prices: { QQQ: "200", XLV: "100" },
      bars: {
        QQQ: [bar("QQQ", "2026-03-06", "200", "200"), bar("QQQ", "2026-03-09", "200", "201")],
        XLV: [bar("XLV", "2026-03-06", "100", "100"), bar("XLV", "2026-03-09", "100", "99")],
      },
      gate,
    });

  it("HOLD_ONLY freezes the book: neither the entry nor the exit trades, and both are on the record", () => {
    const r = rotationUnder({ newRiskAllowed: false, haltState: "HOLD_ONLY" });
    expect(r.fills).toEqual([]);
    expect(r.suppressedEntries).toEqual(["QQQ"]);
    expect(r.suppressedExits).toEqual(["XLV"]);
  });

  it("HOLD_ONLY records a held exit it could not price: a suspended holding is frozen and on the record (Codex P2, PR #108 round 5)", () => {
    // VTI is held, untargeted, and has no decision-session close, so rebalanceOrders never builds its exit.
    const r = fill({
      targets: { QQQ: "1" },
      positions: { XLV: "400", VTI: "10" },
      cash: "0",
      prices: { QQQ: "200", XLV: "100" },
      bars: {
        QQQ: [bar("QQQ", "2026-03-06", "200", "200"), bar("QQQ", "2026-03-09", "200", "201")],
        XLV: [bar("XLV", "2026-03-06", "100", "100"), bar("XLV", "2026-03-09", "100", "99")],
      },
      gate: { newRiskAllowed: false, haltState: "HOLD_ONLY" },
    });
    expect(r.fills).toEqual([]);
    expect(r.suppressedExits).toEqual(["VTI", "XLV"]);
    // Control: an unpriced holding the target still wants has no known direction - unpriced, not an exit.
    const kept = fill({
      targets: { QQQ: "0.5", VTI: "0.5" },
      positions: { VTI: "10" },
      cash: "40000",
      prices: { QQQ: "200" },
      bars: { QQQ: [bar("QQQ", "2026-03-06", "200", "200"), bar("QQQ", "2026-03-09", "200", "201")] },
      gate: { newRiskAllowed: false, haltState: "HOLD_ONLY" },
    });
    expect(kept.suppressedExits).toEqual([]);
    expect(kept.unpriced).toEqual(["VTI"]);
    expect(kept.suppressedEntries).toEqual(["QQQ"]);
  });

  it("HOLD_ONLY keeps its exits on the record when a non-positive NAV stops sizing (Codex P2, PR #108 round 7)", () => {
    // NAV = -5000 + 10 x 100 < 0: nothing can be sized, but XLV is held and the target removed it - a frozen exit.
    const underwater = (targets: Record<string, string>, haltState: "NORMAL" | "HOLD_ONLY") =>
      fill({ targets, positions: { XLV: "10" }, cash: "-5000", prices: { XLV: "100" }, bars: { XLV: [bar("XLV", "2026-03-06", "100", "100")] }, gate: { newRiskAllowed: haltState === "NORMAL", haltState } });
    const r = underwater({ QQQ: "1" }, "HOLD_ONLY");
    expect(r.fills).toEqual([]);
    expect(r.suppressedExits).toEqual(["XLV"]);
    expect(r.suppressedEntries).toEqual([]);
    // Controls: a held line still targeted has no known direction; NORMAL suppresses nothing.
    expect(underwater({ XLV: "1" }, "HOLD_ONLY").suppressedExits).toEqual([]);
    expect(underwater({ QQQ: "1" }, "NORMAL").suppressedExits).toEqual([]);
  });

  it("HALT_NEW_RISK keeps the exit and cancels only the entry (control: the two states differ)", () => {
    const r = rotationUnder({ newRiskAllowed: false, haltState: "HALT_NEW_RISK" });
    expect(qty(r, "XLV", "SELL").toFixed()).toBe("400");
    expect(qty(r, "QQQ", "BUY").toFixed()).toBe("0");
    expect(r.suppressedEntries).toEqual(["QQQ"]);
    expect(r.suppressedExits).toEqual([]);
  });
});
