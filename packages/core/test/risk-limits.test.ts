import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Dec, ONE, sumDec } from "@blackgold/shared";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import { RiskConfigSchema, type RiskConfig } from "../src/config/schema.ts";
import { evaluateRiskLimits } from "../src/risk/limits.ts";

const CHARTER: Charter = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
const POLICY: RiskConfig = RiskConfigSchema.parse({});

/** Build a weights map from an object of decimal strings; cash is 1 - sum. */
function book(w: Record<string, string>): { weights: Map<string, Dec>; cashWeight: Dec } {
  const weights = new Map(Object.entries(w).map(([k, s]) => [k, new Dec(s)] as const));
  return { weights, cashWeight: ONE.minus(sumDec(weights.values())) };
}

function verdict(w: Record<string, string>) {
  const { weights, cashWeight } = book(w);
  return evaluateRiskLimits({ policy: POLICY, charter: CHARTER, weights, cashWeight });
}

const codes = (w: Record<string, string>): string[] => verdict(w).violations.map((x) => x.code);

describe("evaluateRiskLimits", () => {
  it("admits a book within every cap", () => {
    // Five distinct sectors, none in cluster A, 19% each -> 95% gross, 5% cash.
    const r = verdict({ XLF: "0.19", XLV: "0.19", XLU: "0.19", XLP: "0.19", XLI: "0.19" });
    expect(r.admitted).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("admits an all-cash book trivially", () => {
    const r = evaluateRiskLimits({ policy: POLICY, charter: CHARTER, weights: new Map(), cashWeight: ONE });
    expect(r.admitted).toBe(true);
  });

  it("rejects a single ETF above the per-instrument cap", () => {
    expect(codes({ XLF: "0.25", XLV: "0.10" })).toContain("SINGLE_ETF_WEIGHT");
  });

  it("rejects a negative (short) target weight", () => {
    expect(codes({ XLF: "-0.05", XLV: "0.10" })).toContain("NEGATIVE_WEIGHT");
  });

  it("rejects a book that breaches the cash floor", () => {
    // 0.99 invested leaves 0.01 cash, below the 0.02 floor.
    expect(codes({ XLF: "0.20", XLV: "0.20", XLU: "0.20", XLP: "0.20", XLI: "0.19" })).toContain("MIN_CASH");
  });

  it("rejects a book over gross exposure", () => {
    // 6 x 0.18 = 1.08 gross.
    expect(codes({ XLF: "0.18", XLV: "0.18", XLU: "0.18", XLP: "0.18", XLI: "0.18", XLY: "0.18" })).toContain("GROSS_EXPOSURE");
  });

  it("rejects sector concentration above the cap", () => {
    // XLK and QQQ are the two technology ETFs: 0.15 + 0.15 = 0.30 in sector_technology, over 0.20.
    expect(codes({ XLK: "0.15", QQQ: "0.15" })).toContain("SECTOR_CONCENTRATION");
  });

  it("rejects correlated-cluster weight above the cap", () => {
    // VTI + XLK are both in cluster A: 0.16 + 0.16 = 0.32, over 0.30. Two members, within max_members.
    const r = verdict({ VTI: "0.16", XLK: "0.16" });
    expect(r.violations.map((x) => x.code)).toContain("CLUSTER_WEIGHT");
  });

  it("rejects holding more cluster members than max_members", () => {
    // Four of cluster A's members (max_members is 3), each small so the cluster weight stays within its cap.
    const c = codes({ VTI: "0.07", QQQ: "0.07", VUG: "0.07", XLK: "0.07" });
    expect(c).toContain("CLUSTER_MEMBERS");
    expect(c).not.toContain("CLUSTER_WEIGHT");
  });

  it("rejects too many open positions against the stricter charter cap", () => {
    // The charter's max_positions is 5, stricter than risk.yaml's 10, so six admitted ETFs already breach.
    const six = codes({ XLF: "0.10", XLV: "0.10", XLU: "0.10", XLP: "0.10", XLI: "0.10", XLK: "0.10" });
    expect(six).toContain("MAX_OPEN_POSITIONS");
    // And a book well over both caps still breaches.
    const w: Record<string, string> = {};
    for (const s of ["VTI", "QQQ", "IWM", "VTV", "VUG", "XLK", "XLF", "XLV", "XLI", "XLP", "XLU"]) w[s] = "0.05";
    expect(codes(w)).toContain("MAX_OPEN_POSITIONS");
  });

  it("rejects a holding outside the admitted universe, even one the charter classifies", () => {
    // SPY is not a universe member at all.
    expect(codes({ SPY: "0.10", XLF: "0.10" })).toContain("NOT_ADMITTED");
    // XLE IS classified in the charter's factor block, but its conditional entry is not admitted.
    expect(codes({ XLE: "0.10", XLF: "0.10" })).toContain("NOT_ADMITTED");
  });

  it("fails closed on an admitted holding the charter has not classified", () => {
    // Remove an admitted ETF's factor assignment: it stays admitted but its sector cannot be checked.
    const c = structuredClone(CHARTER);
    if (c.factors) delete c.factors.assignments["XLF"];
    const r = evaluateRiskLimits({ policy: POLICY, charter: c, weights: new Map([["XLF", new Dec("0.10")]]), cashWeight: new Dec("0.90") });
    expect(r.violations.map((x) => x.code)).toContain("UNCLASSIFIED_HOLDING");
  });
});
