import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { InvalidCharterError, loadCharterFile, parseCharter, type Charter } from "../src/strategy/charter.ts";
import { classifyCandidateFactors, factorTaxonomy, unclassifiedRiskEtfs } from "../src/strategy/factors.ts";

const CHARTER_PATH = fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url));

function loaded(): Charter {
  return loadCharterFile(CHARTER_PATH).charter;
}

/** A deep clone whose `factors` block is guaranteed present, for mutation in the negative cases. */
function withFactors(): Charter & { factors: NonNullable<Charter["factors"]> } {
  const c = structuredClone(loaded());
  if (!c.factors) throw new Error("fixture charter is expected to declare a factors block");
  return c as Charter & { factors: NonNullable<Charter["factors"]> };
}

describe("classifyCandidateFactors", () => {
  it("classifies an assigned candidate from the charter", () => {
    const c = classifyCandidateFactors(loaded(), "XLK");
    expect(c.classified).toBe(true);
    expect([...c.factors].sort()).toEqual(["growth", "market", "sector_technology"]);
  });

  it("fails closed on a candidate the charter does not classify", () => {
    // SPY is a plausible ticker but is not a member of this universe, so it has no assignment.
    const c = classifyCandidateFactors(loaded(), "SPY");
    expect(c.classified).toBe(false);
    expect(c.factors.size).toBe(0);
  });

  it("classifies the conditional member (XLE) even though it is not yet admitted", () => {
    // So admitting XLE later is not also a factor edit; both are charter changes, but they need not coincide.
    const c = classifyCandidateFactors(loaded(), "XLE");
    expect(c.classified).toBe(true);
    expect(c.factors.has("sector_energy")).toBe(true);
  });

  it("returns unclassified for every symbol when the charter carries no factors block", () => {
    const c = structuredClone(loaded());
    delete c.factors;
    expect(classifyCandidateFactors(c, "XLK").classified).toBe(false);
    expect(factorTaxonomy(c).size).toBe(0);
  });
});

describe("factorTaxonomy and completeness", () => {
  it("exposes the charter's closed vocabulary", () => {
    const tax = factorTaxonomy(loaded());
    expect(tax.has("market")).toBe(true);
    expect(tax.has("sector_energy")).toBe(true);
    expect(tax.has("not_a_real_factor")).toBe(false);
  });

  it("has an assignment for every admitted risk ETF (no fail-closed gap in the shipped charter)", () => {
    expect(unclassifiedRiskEtfs(loaded())).toEqual([]);
  });

  it("reports an admitted risk ETF that lacks an assignment as an unclassified gap", () => {
    const c = withFactors();
    delete c.factors.assignments["XLK"];
    expect(unclassifiedRiskEtfs(c)).toContain("XLK");
  });
});

describe("factors structural validation", () => {
  it("rejects an assignment tag that is not in the taxonomy", () => {
    const c = withFactors();
    c.factors.assignments["XLK"] = ["market", "not_in_taxonomy"];
    expect(() => parseCharter(c)).toThrow(InvalidCharterError);
  });

  it("rejects an assignment for a symbol that is not a universe member", () => {
    const c = withFactors();
    c.factors.assignments["SPY"] = ["market"];
    expect(() => parseCharter(c)).toThrow(/not a universe member/);
  });

  it("rejects a duplicate tag in one assignment", () => {
    const c = withFactors();
    c.factors.assignments["XLK"] = ["market", "market"];
    expect(() => parseCharter(c)).toThrow(/lists a factor tag twice/);
  });
});
