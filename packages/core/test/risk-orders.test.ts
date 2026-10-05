import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Dec } from "@blackgold/shared";
import { RiskConfigSchema, type RiskConfig } from "../src/config/schema.ts";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import { bindingAdvParticipation, bindingNewPositionsPerSession, evaluateOrderLimits, type SessionOrder } from "../src/risk/orders.ts";

// Shipped policy: qty cap 1000, notional cap 1500 USD, 4 orders/session, turnover 0.25 of NAV, ADV participation
// 0.01, 3 new positions/session, min ADV 5M, min price 5.00, max spread 50 bps. The charter: participation 0.005
// (its cost model), 5 new positions per decision.
const POLICY: RiskConfig = RiskConfigSchema.parse({});
const CHARTER: Charter = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
const ADV = new Dec("900000000");

function order(entityId: string, side: "BUY" | "SELL", qty: string, price: string, over: Partial<SessionOrder> = {}): SessionOrder {
  const p = new Dec(price);
  return { entityId, side, quantity: new Dec(qty), price: p, advUsd: ADV, quote: { bid: p.minus("0.01"), ask: p }, ...over };
}
function run(orders: SessionOrder[], opts: { navUsd?: string; held?: Record<string, string>; policy?: RiskConfig } = {}) {
  return evaluateOrderLimits({
    policy: opts.policy ?? POLICY,
    charter: CHARTER,
    navUsd: new Dec(opts.navUsd ?? "100000"),
    held: new Map(Object.entries(opts.held ?? {}).map(([k, v]) => [k, new Dec(v)] as const)),
    orders,
  });
}
const codes = (v: { violations: { code: string }[] }) => v.violations.map((x) => x.code);

describe("evaluateOrderLimits: a clean session", () => {
  it("admits orders inside every cap", () => {
    const v = run([order("XLF", "BUY", "20", "50"), order("XLV", "SELL", "10", "140")], { held: { XLV: "10" } });
    expect(v).toEqual({ admitted: true, violations: [] });
  });

  it("admits an empty session", () => {
    expect(run([])).toEqual({ admitted: true, violations: [] });
  });
});

describe("evaluateOrderLimits: per-order size caps apply to every order, exits included", () => {
  it("quantity: at the cap passes, one over fails; fractional and non-positive are malformed", () => {
    const cheap = { policy: { ...POLICY, orderLimits: { ...POLICY.orderLimits, maxOrderNotionalUsd: "1000000" } }, navUsd: "100000000" };
    expect(codes(run([order("XLF", "BUY", "1000", "50")], cheap))).toEqual([]);
    expect(codes(run([order("XLF", "BUY", "1001", "50")], cheap))).toEqual(["QTY_CAP"]);
    expect(codes(run([order("XLF", "BUY", "1.5", "50")]))).toEqual(["BAD_QUANTITY"]);
    expect(codes(run([order("XLF", "BUY", "0", "50")]))).toEqual(["BAD_QUANTITY"]);
  });

  it("notional: at 1500 USD passes, one cent over fails - for a sell too", () => {
    expect(codes(run([order("XLF", "BUY", "30", "50")]))).toEqual([]);
    expect(codes(run([order("XLF", "BUY", "30", "50.01")]))).toEqual(["NOTIONAL_CAP"]);
    expect(codes(run([order("XLF", "SELL", "30", "50.01")], { held: { XLF: "30" } }))).toEqual(["NOTIONAL_CAP"]);
  });

  it("a non-positive reference price is malformed: the notional is unknown", () => {
    expect(codes(run([order("XLF", "SELL", "10", "0")], { held: { XLF: "10" } }))).toEqual(["BAD_PRICE"]);
  });

  it("ADV participation binds at the STRICTER of risk.yaml (1%) and the charter's cost model (0.5%)", () => {
    expect(bindingAdvParticipation(POLICY, CHARTER).toFixed()).toBe("0.005");
    // 1500 USD notional against ADV 300,000: 0.5% is exactly 1500 (passes); ADV 299,999 fails - though 1% would pass.
    const thin = (adv: string) => run([order("XLF", "SELL", "30", "50", { advUsd: new Dec(adv) })], { held: { XLF: "30" } });
    expect(codes(thin("300000"))).toEqual([]);
    expect(codes(thin("299999"))).toEqual(["ADV_PARTICIPATION"]);
    // A looser charter would leave risk.yaml binding.
    const loose = { ...CHARTER, costs: { ...CHARTER.costs, max_participation_of_adv: "0.05" } };
    expect(bindingAdvParticipation(POLICY, loose).toFixed()).toBe("0.01");
  });

  it("fails closed when ADV is unknown, for any side", () => {
    expect(codes(run([order("XLF", "SELL", "10", "50", { advUsd: undefined })], { held: { XLF: "10" } }))).toEqual(["ADV_UNKNOWN"]);
    expect(codes(run([order("XLF", "BUY", "10", "50", { advUsd: undefined })]))).toEqual(["ADV_UNKNOWN"]);
  });
});

describe("evaluateOrderLimits: buys are new risk and must clear the instrument and spread rules", () => {
  it("applies the shared instrument floors to a buy only", () => {
    expect(codes(run([order("PENNY", "BUY", "100", "4.99")]))).toEqual(["MIN_PRICE"]);
    expect(codes(run([order("PENNY", "SELL", "100", "4.99")], { held: { PENNY: "100" } }))).toEqual([]);
    // ADV under the 5M floor; the order is small enough to clear participation, so the floor alone is named.
    expect(codes(run([order("THIN", "BUY", "1", "10", { advUsd: new Dec("4000000") })]))).toEqual(["MIN_ADV"]);
  });

  it("spread: at 50 bps of mid passes, wider fails; a sell is not spread-checked", () => {
    // bid 99.75 / ask 100.25: 0.50 over a mid of 100 is exactly 50 bps.
    const at = order("XLF", "BUY", "10", "100.25", { quote: { bid: new Dec("99.75"), ask: new Dec("100.25") } });
    expect(codes(run([at]))).toEqual([]);
    const wide = order("XLF", "BUY", "10", "100.26", { quote: { bid: new Dec("99.74"), ask: new Dec("100.26") } });
    expect(codes(run([wide]))).toEqual(["SPREAD"]);
    expect(codes(run([{ ...wide, side: "SELL" }], { held: { XLF: "10" } }))).toEqual([]);
  });

  it("fails a buy closed with no quote (end-of-day data carries none) and on a crossed or empty quote", () => {
    expect(codes(run([order("XLF", "BUY", "10", "50", { quote: undefined })]))).toEqual(["SPREAD_UNOBSERVED"]);
    expect(codes(run([order("XLF", "BUY", "10", "50", { quote: { bid: new Dec("50.10"), ask: new Dec("50") } })]))).toEqual(["BAD_QUOTE"]);
    expect(codes(run([order("XLF", "BUY", "10", "50", { quote: { bid: new Dec("0"), ask: new Dec("50") } })]))).toEqual(["BAD_QUOTE"]);
    // A sell with no quote is not new risk and is not blocked for it.
    expect(codes(run([order("XLF", "SELL", "10", "50", { quote: undefined })], { held: { XLF: "10" } }))).toEqual([]);
  });
});

describe("evaluateOrderLimits: the book is long-only", () => {
  it("rejects a session whose sells of one entity exceed the shares held, summed across orders", () => {
    expect(codes(run([order("XLF", "SELL", "10", "50")], { held: { XLF: "10" } }))).toEqual([]);
    expect(codes(run([order("XLF", "SELL", "6", "50"), order("XLF", "SELL", "5", "50")], { held: { XLF: "10" } }))).toEqual(["SELL_EXCEEDS_HELD"]);
    expect(codes(run([order("XLF", "SELL", "1", "50")]))).toEqual(["SELL_EXCEEDS_HELD"]);
  });
});

describe("evaluateOrderLimits: per-session caps", () => {
  const roomy = { navUsd: "1000000" };

  it("orders per session: four pass, five fail", () => {
    const four = ["XLF", "XLV", "XLU", "XLP"].map((id) => order(id, "SELL", "1", "50"));
    const held = { XLF: "1", XLV: "1", XLU: "1", XLP: "1", XLI: "1" };
    expect(codes(run(four, { ...roomy, held }))).toEqual([]);
    expect(codes(run([...four, order("XLI", "SELL", "1", "50")], { ...roomy, held }))).toEqual(["MAX_ORDERS_PER_SESSION"]);
  });

  it("new positions bind at the STRICTER of risk.yaml (3) and the charter (5); adding to a holding is not new", () => {
    expect(bindingNewPositionsPerSession(POLICY, CHARTER)).toBe(3);
    const loose = { ...POLICY, orderLimits: { ...POLICY.orderLimits, maxOrdersPerSession: 10 } };
    const three = ["XLF", "XLV", "XLU"].map((id) => order(id, "BUY", "1", "50"));
    expect(codes(run(three, { ...roomy, policy: loose }))).toEqual([]);
    expect(codes(run([...three, order("XLP", "BUY", "1", "50")], { ...roomy, policy: loose }))).toEqual(["MAX_NEW_POSITIONS"]);
    // The fourth buy adds to a held line: still three new positions.
    expect(codes(run([...three, order("XLP", "BUY", "1", "50")], { ...roomy, policy: loose, held: { XLP: "5" } }))).toEqual([]);
  });

  it("turnover is GROSS traded notional over NAV: at 25% passes, above fails, buys and sells both count", () => {
    // 1250 bought + 1250 sold = 2500 = 25% of 10,000.
    const pair = [order("XLF", "BUY", "25", "50"), order("XLV", "SELL", "25", "50")];
    expect(codes(run(pair, { navUsd: "10000", held: { XLV: "25" } }))).toEqual([]);
    expect(codes(run(pair, { navUsd: "9999.99", held: { XLV: "25" } }))).toEqual(["DAILY_TURNOVER"]);
  });

  it("fails closed on a non-positive NAV: turnover cannot be measured", () => {
    expect(codes(run([order("XLF", "BUY", "1", "50")], { navUsd: "0" }))).toEqual(["BAD_NAV"]);
  });
});

describe("evaluateOrderLimits: every breach is named, never resolved", () => {
  it("reports each failing rule in one verdict and leaves the orders as given", () => {
    const orders = [order("XLF", "BUY", "2000", "50", { quote: undefined })];
    const v = run(orders);
    expect(v.admitted).toBe(false);
    expect(codes(v)).toEqual(["QTY_CAP", "NOTIONAL_CAP", "SPREAD_UNOBSERVED", "DAILY_TURNOVER"]);
    expect(orders[0]?.quantity.toFixed()).toBe("2000");
  });
});
