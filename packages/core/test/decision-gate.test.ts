import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Dec, ONE, sumDec, utc } from "@blackgold/shared";
import { RiskConfigSchema, RestrictedListConfigSchema, type RiskConfig, type RestrictedListConfig } from "../src/config/schema.ts";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import type { HaltInput, PortfolioSnapshot } from "../src/risk/halt.ts";
import type { RiskLimitsInput } from "../src/risk/limits.ts";
import type { ComplianceInput } from "../src/compliance/engine.ts";
import { evaluateDecisionGate } from "../src/decision/gate.ts";

const POLICY: RiskConfig = RiskConfigSchema.parse({});
const CHARTER: Charter = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
const RL: RestrictedListConfig = RestrictedListConfigSchema.parse({ asOf: "2026-09-01", etfs: ["FAKEAG"] });
const NOW = utc("2026-09-10T14:00:00Z");

function snapshot(nav: number, hwm = 100, start = 100): PortfolioSnapshot {
  return { nav: new Dec(nav), highWaterMark: new Dec(hwm), sessionStartNav: new Dec(start) };
}
function halt(portfolio: PortfolioSnapshot): HaltInput {
  return { policy: POLICY, current: "NORMAL", portfolio };
}
function book(w: Record<string, string>): RiskLimitsInput {
  const weights = new Map(Object.entries(w).map(([k, s]) => [k, new Dec(s)] as const));
  return { policy: POLICY, charter: CHARTER, weights, cashWeight: ONE.minus(sumDec(weights.values())) };
}
function candidate(symbol: string, over: Partial<Omit<ComplianceInput, "isNewRisk" | "symbol">> = {}): Omit<ComplianceInput, "isNewRisk"> {
  return { symbol, identifiers: [symbol], entityId: undefined, themeExposures: [], restrictedList: RL, now: NOW, maxListAgeDays: 120, ...over };
}

const CLEAN_BOOK = { XLF: "0.19", XLV: "0.19", XLU: "0.19", XLP: "0.19", XLI: "0.19" };

describe("evaluateDecisionGate", () => {
  it("allows new risk only when halt, limits, and compliance all clear", () => {
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book(CLEAN_BOOK),
      newRiskCandidates: [candidate("XLF"), candidate("XLV")],
    });
    expect(v.newRiskAllowed).toBe(true);
    expect(v.blockedBy).toEqual([]);
    expect(v.haltState).toBe("NORMAL");
  });

  it("blocks when the halt state forbids new risk, whatever the book and candidates", () => {
    // 10% drawdown -> HOLD_ONLY.
    const v = evaluateDecisionGate({
      halt: halt(snapshot(90)),
      limits: book(CLEAN_BOOK),
      newRiskCandidates: [candidate("XLF")],
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.haltState).toBe("HOLD_ONLY");
    expect(v.blockedBy.some((b) => b.includes("halt state HOLD_ONLY"))).toBe(true);
  });

  it("blocks when the proposed book breaches a risk limit", () => {
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book({ XLF: "0.25", XLV: "0.10" }),
      newRiskCandidates: [candidate("XLV")],
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.limits.admitted).toBe(false);
    expect(v.blockedBy.some((b) => b.startsWith("limit SINGLE_ETF_WEIGHT"))).toBe(true);
  });

  it("blocks when a new-risk candidate fails compliance", () => {
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book(CLEAN_BOOK),
      newRiskCandidates: [candidate("XLF"), candidate("FAKEAG")],
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.blockedBy.some((b) => b.startsWith("compliance FAKEAG RESTRICTED_ETF"))).toBe(true);
  });

  it("aggregates every blocking reason across the three engines", () => {
    const v = evaluateDecisionGate({
      halt: halt(snapshot(90)), // HOLD_ONLY
      limits: book({ XLF: "0.25", XLV: "0.10" }), // limit breach
      newRiskCandidates: [candidate("FAKEAG")], // compliance breach
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.blockedBy.some((b) => b.includes("halt state"))).toBe(true);
    expect(v.blockedBy.some((b) => b.startsWith("limit "))).toBe(true);
    expect(v.blockedBy.some((b) => b.startsWith("compliance "))).toBe(true);
  });

  it("evaluates compliance as new risk even though the caller omits isNewRisk", () => {
    // FAKEAG would be compliance-clear as a reduction; the gate must treat it as new risk and block it.
    const v = evaluateDecisionGate({ halt: halt(snapshot(100)), limits: book({}), newRiskCandidates: [candidate("FAKEAG")] });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.blockedBy.some((b) => b.includes("RESTRICTED_ETF"))).toBe(true);
  });
});
