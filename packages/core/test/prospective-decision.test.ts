import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { ONE, ZERO } from "@blackgold/shared";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import { backtestParamsFromCharter, costsFromCharter, runBacktest, type BacktestInput } from "../src/research/backtest.ts";
import { deterministicTargetBook, passiveTargetBook, prospectiveTargetBooks, type ArmTargetWeight } from "../src/decision/prospective.ts";
import { buildMarket, D, N, type PricePath } from "./strategy-fixture.ts";

// A charter with short feature windows so a few hundred fixture sessions exercise the same code the registered
// 252/200/63 windows do (mirrors research-backtest.test.ts). Only window lengths change.
function shortCharter(): Charter {
  const base = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
  const c = structuredClone(base);
  c.universe.risk_etfs = ["VTI", "QQQ", "IWM", "VTV", "VUG", "XLK", "XLV", "XLU"];
  c.universe.conditional = [];
  c.universe.look_through_flagged = [];
  c.sizing.clusters = [{ id: "A", members: ["VTI", "QQQ", "VUG", "XLK"], max_members: 3 }];
  c.features = { ...c.features, momentum_lookback_sessions: 20, momentum_skip_sessions: 4, trend_sma_sessions: 10, volatility_sessions: 15, adv_sessions: 5, min_adv_usd: "1000000" };
  return c;
}

const PATHS: PricePath[] = [
  { entityId: "VTI", start: N("200"), perSession: N("1.0010"), volumeShares: 4_000_000n, wobble: N("0.003") },
  { entityId: "QQQ", start: N("400"), perSession: N("1.0018"), volumeShares: 5_000_000n, wobble: N("0.005") },
  { entityId: "IWM", start: N("180"), perSession: N("1.0006"), volumeShares: 3_000_000n, wobble: N("0.004") },
  { entityId: "VTV", start: N("150"), perSession: N("1.0004"), volumeShares: 2_000_000n, wobble: N("0.002") },
  { entityId: "VUG", start: N("300"), perSession: N("1.0014"), volumeShares: 3_500_000n, wobble: N("0.004") },
  { entityId: "XLK", start: N("200"), perSession: N("1.0016"), volumeShares: 4_500_000n, wobble: N("0.005") },
  { entityId: "XLV", start: N("140"), perSession: N("1.0008"), volumeShares: 2_500_000n, wobble: N("0.003") },
  { entityId: "XLU", start: N("70"), perSession: N("0.9994"), volumeShares: 2_000_000n, wobble: N("0.002") },
  { entityId: "BIL", start: N("91"), perSession: N("1.00008"), volumeShares: 900_000n },
  { entityId: "SPY", start: N("500"), perSession: N("1.0010"), volumeShares: 6_000_000n, wobble: N("0.003") },
];

function fixture() {
  const charter = shortCharter();
  const market = buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-06-30") });
  const input: BacktestInput = {
    charter,
    charterHash: "sha256:" + "0".repeat(64),
    pit: market.pit,
    calendar: market.calendar,
    from: D("2026-03-02"),
    to: D("2026-06-30"),
    initialCash: N("100000"),
    costs: costsFromCharter(charter, "base"),
    params: backtestParamsFromCharter(charter),
  };
  return { charter, market, input };
}

const asPairs = (weights: ArmTargetWeight[]): [string, string][] => weights.map((w) => [w.entityId, w.weight.toFixed()]);

function firstBacktestDecision(input: BacktestInput) {
  const first = runBacktest(input).decisions.at(0);
  if (first === undefined) throw new Error("fixture produced no backtest decision");
  return first;
}

describe("prospective deterministic target book matches the backtest (anti-drift)", () => {
  it("reproduces runBacktest's first B1 decision from the same point-in-time reads", () => {
    const { charter, market, input } = fixture();
    const first = firstBacktestDecision(input);

    // At the first decision the backtest holds nothing, so hysteresis has no prior book to read.
    const book = deterministicTargetBook(charter, { pit: market.pit, calendar: market.calendar }, first.decisionAt, new Set());

    expect(book.arm).toBe("B1_DETERMINISTIC");
    expect(book.anchorSession).toBe(first.anchorSession);
    // The sealed number that matters: the target weights, byte-for-byte via decimal .toFixed().
    const backtestWeights = [...first.targets.weights]
      .map(([entityId, weight]) => ({ entityId, weight }))
      .sort((a, b) => (a.entityId < b.entityId ? -1 : 1));
    expect(asPairs(book.targetWeights)).toEqual(asPairs(backtestWeights));
    expect(book.cashWeight.toFixed()).toBe(first.targets.cashWeight.toFixed());
  });

  it("is deterministic: the same instant computes the same book", () => {
    const { charter, market, input } = fixture();
    const at = firstBacktestDecision(input).decisionAt;
    const a = deterministicTargetBook(charter, { pit: market.pit, calendar: market.calendar }, at, new Set());
    const b = deterministicTargetBook(charter, { pit: market.pit, calendar: market.calendar }, at, new Set());
    expect(asPairs(a.targetWeights)).toEqual(asPairs(b.targetWeights));
    expect(a.cashWeight.toFixed()).toBe(b.cashWeight.toFixed());
  });
});

describe("passive target book (B0)", () => {
  it("is fully invested in the primary benchmark and makes no signal read", () => {
    const { charter, market, input } = fixture();
    const at = firstBacktestDecision(input).decisionAt;
    const b0 = passiveTargetBook(charter, { pit: market.pit, calendar: market.calendar }, at);
    expect(b0.arm).toBe("B0_PASSIVE");
    expect(b0.targetWeights).toEqual([{ entityId: charter.benchmarks.primary, weight: ONE }]);
    expect(b0.cashWeight.eq(ZERO)).toBe(true);
    expect(b0.labels).toEqual([]);
  });

  it("prospectiveTargetBooks returns both deterministic arms (this charter has no LLM arm)", () => {
    const { charter, market, input } = fixture();
    const at = firstBacktestDecision(input).decisionAt;
    const books = prospectiveTargetBooks(charter, { pit: market.pit, calendar: market.calendar }, at, new Set());
    expect(books.map((b) => b.arm)).toEqual(["B0_PASSIVE", "B1_DETERMINISTIC"]);
  });
});
