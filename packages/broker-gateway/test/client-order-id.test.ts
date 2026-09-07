import { describe, expect, it } from "vitest";
import { dec, utc } from "@blackgold/shared";
import { clientOrderIdFor, type ClientOrderIdFields } from "../src/index.ts";

const base: ClientOrderIdFields = {
  intentId: "intent_fixture_1",
  strategyVersion: "etf-trend-vol@1.0.0",
  symbol: "SPY",
  side: "BUY",
  quantity: dec(100),
  decisionAt: utc("2026-09-08T14:30:00Z"),
};

describe("clientOrderIdFor", () => {
  it("is a pure function of its declared inputs", () => {
    const a = clientOrderIdFor(base);
    const b = clientOrderIdFor({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^ord_[0-9a-f]{32}$/);
    // Repeated calls, fresh objects, and equal decimals spelled differently all agree.
    expect(clientOrderIdFor({ ...base, quantity: dec("100.0") })).toBe(a);
    expect(clientOrderIdFor({ ...base, decisionAt: utc("2026-09-08T14:30:00.000Z") })).toBe(a);
  });

  it("changes when any declared input changes", () => {
    const a = clientOrderIdFor(base);
    const variants: ClientOrderIdFields[] = [
      { ...base, intentId: "intent_fixture_2" },
      { ...base, strategyVersion: "etf-trend-vol@1.0.1" },
      { ...base, symbol: "QQQ" },
      { ...base, side: "SELL" },
      { ...base, quantity: dec(101) },
      { ...base, decisionAt: utc("2026-09-08T14:30:01Z") },
    ];
    const ids = new Set(variants.map(clientOrderIdFor));
    expect(ids.size).toBe(variants.length);
    expect(ids.has(a)).toBe(false);
  });

  it("does not depend on undeclared inputs such as call order or wall clock", () => {
    const first = clientOrderIdFor(base);
    clientOrderIdFor({ ...base, symbol: "IWM" });
    const again = clientOrderIdFor(base);
    expect(again).toBe(first);
  });
});
