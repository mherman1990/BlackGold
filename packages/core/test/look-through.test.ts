import { describe, expect, it } from "vitest";
import { Dec, isoDate, utc } from "@blackgold/shared";
import {
  evaluateLookThrough,
  lookThroughResolver,
  type EtfHoldings,
  type LookThroughParams,
  type ThemeMembership,
} from "../src/compliance/look-through.ts";

const NOW = utc("2026-09-11T20:00:00Z");
const D = (s: string): Dec => new Dec(s);

/** Membership keyed by canonical identity (entity id when present, else symbol) — the same key the engine uses. */
function membershipFrom(map: Record<string, string[]>): ThemeMembership {
  return (c) => map[c.entityId ?? c.symbol] ?? [];
}

function params(overrides: Partial<LookThroughParams> = {}): LookThroughParams {
  return {
    restrictedThemes: ["soybean_processing", "crop_inputs"],
    maxAggregateThemeWeightPct: D("0.10"),
    maxHoldingsAgeDays: 100,
    ...overrides,
  };
}

function holdings(lines: EtfHoldings["lines"], asOf = "2026-09-01"): EtfHoldings {
  return { etf: "XLP", asOf: isoDate(asOf), lines };
}

describe("evaluateLookThrough: unknown state fails closed", () => {
  it("returns undefined when there are no holdings at all", () => {
    expect(evaluateLookThrough(undefined, membershipFrom({}), params(), NOW)).toBeUndefined();
  });

  it("returns undefined when the holdings file is staler than the freshness limit", () => {
    const h = holdings([{ symbol: "AAA", weight: D("0.02") }], "2026-01-01"); // ~253 days old
    expect(evaluateLookThrough(h, membershipFrom({}), params({ maxHoldingsAgeDays: 90 }), NOW)).toBeUndefined();
  });

  it("runs when the holdings file is exactly at the freshness limit", () => {
    // 2026-06-03 is 100 days before 2026-09-11.
    const h = holdings([{ symbol: "AAA", weight: D("0.02") }], "2026-06-03");
    const v = evaluateLookThrough(h, membershipFrom({ AAA: ["crop_inputs"] }), params({ maxHoldingsAgeDays: 100 }), NOW);
    expect(v).toBeDefined();
  });
});

describe("evaluateLookThrough: the section 2.2 aggregate rule", () => {
  it("admits an ETF with no restricted-theme issuers (empty exposures)", () => {
    const h = holdings([
      { symbol: "AAA", weight: D("0.30") },
      { symbol: "BBB", weight: D("0.25") },
    ]);
    const v = evaluateLookThrough(h, membershipFrom({}), params(), NOW);
    expect(v?.admissible).toBe(true);
    expect(v?.themeExposures).toEqual([]);
    expect(v?.aggregateThemeWeight.toFixed()).toBe("0");
  });

  it("admits when restricted issuers are present but the aggregate is within the threshold (de minimis)", () => {
    const h = holdings([
      { symbol: "SOY", weight: D("0.04") },
      { symbol: "INP", weight: D("0.05") },
      { symbol: "CLEAN", weight: D("0.50") },
    ]);
    const m = membershipFrom({ SOY: ["soybean_processing"], INP: ["crop_inputs"] });
    const v = evaluateLookThrough(h, m, params(), NOW); // aggregate 0.09 <= 0.10
    expect(v?.admissible).toBe(true);
    expect(v?.themeExposures).toEqual([]);
    expect(v?.aggregateThemeWeight.toFixed()).toBe("0.09");
  });

  it("admits at exactly the threshold (at or below is admissible)", () => {
    const h = holdings([{ symbol: "SOY", weight: D("0.10") }]);
    const v = evaluateLookThrough(h, membershipFrom({ SOY: ["soybean_processing"] }), params(), NOW);
    expect(v?.admissible).toBe(true);
    expect(v?.themeExposures).toEqual([]);
  });

  it("blocks and names the present restricted themes when the aggregate exceeds the threshold", () => {
    const h = holdings([
      { symbol: "SOY", weight: D("0.08") },
      { symbol: "INP", weight: D("0.05") },
      { symbol: "CLEAN", weight: D("0.40") },
    ]);
    const m = membershipFrom({ SOY: ["soybean_processing"], INP: ["crop_inputs"] });
    const v = evaluateLookThrough(h, m, params(), NOW); // aggregate 0.13 > 0.10
    expect(v?.admissible).toBe(false);
    expect(v?.themeExposures).toEqual(["crop_inputs", "soybean_processing"]);
    expect(v?.aggregateThemeWeight.toFixed()).toBe("0.13");
  });

  it("counts only themes that are actually restricted, ignoring membership in unrestricted themes", () => {
    const h = holdings([{ symbol: "OIL", weight: D("0.40") }]);
    // OIL is in a theme that is not on the restricted list, so it does not count.
    const v = evaluateLookThrough(h, membershipFrom({ OIL: ["fossil_energy"] }), params(), NOW);
    expect(v?.admissible).toBe(true);
    expect(v?.themeExposures).toEqual([]);
    expect(v?.aggregateThemeWeight.toFixed()).toBe("0");
  });

  it("matches membership by resolved entity id, not only by ticker", () => {
    const h = holdings([{ symbol: "NEWTKR", entityId: "ent-soy", weight: D("0.15") }]);
    const v = evaluateLookThrough(h, membershipFrom({ "ent-soy": ["soybean_processing"] }), params(), NOW);
    expect(v?.admissible).toBe(false);
    expect(v?.themeExposures).toEqual(["soybean_processing"]);
  });

  it("counts a distinct issuer once in the aggregate even across multiple restricted themes", () => {
    const h = holdings([{ symbol: "AGCO", entityId: "ent-agco", weight: D("0.12") }]);
    const m = membershipFrom({ "ent-agco": ["soybean_processing", "crop_inputs"] });
    const v = evaluateLookThrough(h, m, params(), NOW);
    // One issuer at 0.12 -> aggregate 0.12 (not 0.24), over the 0.10 threshold.
    expect(v?.aggregateThemeWeight.toFixed()).toBe("0.12");
    expect(v?.admissible).toBe(false);
    expect(v?.themeExposures).toEqual(["crop_inputs", "soybean_processing"]);
    expect(v?.perThemeWeight).toEqual([
      { theme: "crop_inputs", weight: D("0.12") },
      { theme: "soybean_processing", weight: D("0.12") },
    ]);
  });

  it("de-duplicates a constituent split across lines by taking its greatest weight, not the sum", () => {
    const h = holdings([
      { symbol: "SOY", entityId: "ent-soy", weight: D("0.07") },
      { symbol: "SOY", entityId: "ent-soy", weight: D("0.06") },
    ]);
    const v = evaluateLookThrough(h, membershipFrom({ "ent-soy": ["soybean_processing"] }), params(), NOW);
    // Max 0.07, not 0.13, so the single issuer is within the threshold and the ETF is admissible.
    expect(v?.aggregateThemeWeight.toFixed()).toBe("0.07");
    expect(v?.admissible).toBe(true);
  });
});

describe("lookThroughResolver", () => {
  it("forwards computed theme exposures and undefined for an ETF with no holdings", () => {
    const store: Record<string, EtfHoldings> = {
      XLP: holdings([{ symbol: "SOY", weight: D("0.20") }]),
      XLU: holdings([{ symbol: "CLEAN", weight: D("0.20") }]),
    };
    const resolve = lookThroughResolver((etf) => store[etf], membershipFrom({ SOY: ["soybean_processing"] }), params(), NOW);
    expect(resolve("XLP")).toEqual(["soybean_processing"]); // 0.20 > 0.10
    expect(resolve("XLU")).toEqual([]); // no restricted issuers
    expect(resolve("XLI")).toBeUndefined(); // no holdings -> fails closed
  });
});
