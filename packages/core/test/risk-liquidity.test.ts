import { describe, expect, it } from "vitest";
import { Dec } from "@blackgold/shared";
import { RiskConfigSchema, type RiskConfig } from "../src/config/schema.ts";
import { evaluateLiquidityLimits, instrumentLiquidityViolations, type LiquidityFacts } from "../src/risk/liquidity.ts";

// Shipped defaults: minAdvUsd 5,000,000 and minPriceUsd 5.00.
const POLICY: RiskConfig = RiskConfigSchema.parse({});
const facts = (advUsd: string | undefined, price: string | undefined): LiquidityFacts => ({
  advUsd: advUsd === undefined ? undefined : new Dec(advUsd),
  price: price === undefined ? undefined : new Dec(price),
});
const codes = (v: { code: string }[]) => v.map((x) => x.code);

describe("instrumentLiquidityViolations", () => {
  it("admits an instrument at or above both floors (boundary: exactly at each floor passes)", () => {
    expect(instrumentLiquidityViolations(POLICY, "XLF", facts("900000000", "40"))).toEqual([]);
    expect(instrumentLiquidityViolations(POLICY, "XLF", facts("5000000", "5.00"))).toEqual([]);
  });

  it("rejects an instrument just below either floor, naming each", () => {
    expect(codes(instrumentLiquidityViolations(POLICY, "XLF", facts("4999999.99", "40")))).toEqual(["MIN_ADV"]);
    expect(codes(instrumentLiquidityViolations(POLICY, "XLF", facts("900000000", "4.99")))).toEqual(["MIN_PRICE"]);
    expect(codes(instrumentLiquidityViolations(POLICY, "XLF", facts("1", "1")))).toEqual(["MIN_ADV", "MIN_PRICE"]);
  });

  it("fails closed on missing or non-positive facts, and says which", () => {
    const none = instrumentLiquidityViolations(POLICY, "XLF", undefined);
    expect(codes(none)).toEqual(["LIQUIDITY_UNKNOWN"]);
    expect(none[0]?.detail).toContain("no usable ADV and price;");
    expect(instrumentLiquidityViolations(POLICY, "XLF", facts(undefined, "40"))[0]?.detail).toContain("no usable ADV;");
    expect(instrumentLiquidityViolations(POLICY, "XLF", facts("900000000", undefined))[0]?.detail).toContain("no usable price;");
    expect(codes(instrumentLiquidityViolations(POLICY, "XLF", facts("0", "40")))).toEqual(["LIQUIDITY_UNKNOWN"]);
    expect(codes(instrumentLiquidityViolations(POLICY, "XLF", facts("900000000", "-1")))).toEqual(["LIQUIDITY_UNKNOWN"]);
  });

  it("reads the floors from the policy, not constants", () => {
    const strict = { ...POLICY, liquidity: { ...POLICY.liquidity, minAdvUsd: "1000000000", minPriceUsd: "100" } };
    expect(codes(instrumentLiquidityViolations(strict, "XLF", facts("900000000", "40")))).toEqual(["MIN_ADV", "MIN_PRICE"]);
  });
});

describe("evaluateLiquidityLimits", () => {
  const book = new Map<string, LiquidityFacts>([
    ["XLF", facts("900000000", "40")],
    ["THIN", facts("100000", "40")],
  ]);

  it("checks only the increasing holdings it is given", () => {
    expect(evaluateLiquidityLimits({ policy: POLICY, increasing: ["XLF"], facts: book })).toEqual({ admitted: true, violations: [] });
    expect(evaluateLiquidityLimits({ policy: POLICY, increasing: [], facts: book }).admitted).toBe(true);
  });

  it("rejects an illiquid increasing holding, and an increasing holding with no facts at all", () => {
    const v = evaluateLiquidityLimits({ policy: POLICY, increasing: ["XLF", "THIN", "GHOST"], facts: book });
    expect(v.admitted).toBe(false);
    expect(v.violations.map((x) => `${x.code}:${x.detail.split(" ")[0] ?? ""}`)).toEqual(["LIQUIDITY_UNKNOWN:GHOST", "MIN_ADV:THIN"]);
  });

  it("reports a holding once, in entity order, however it is listed", () => {
    const v = evaluateLiquidityLimits({ policy: POLICY, increasing: ["THIN", "THIN"], facts: book });
    expect(codes(v.violations)).toEqual(["MIN_ADV"]);
  });
});
