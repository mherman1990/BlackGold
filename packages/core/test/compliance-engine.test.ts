import { describe, expect, it } from "vitest";
import { utc } from "@blackgold/shared";
import { RestrictedListConfigSchema, type RestrictedListConfig } from "../src/config/schema.ts";
import { evaluateCompliance, type ComplianceInput } from "../src/compliance/engine.ts";

const RL: RestrictedListConfig = RestrictedListConfigSchema.parse({
  asOf: "2026-09-01",
  coolingPeriodDays: 30,
  names: ["FAKE_EMPLOYER_CO"],
  themes: ["soybean_processing"],
  etfs: ["FAKEAG"],
  blackouts: [{ from: "2026-10-01", to: "2026-10-15", reason: "board meeting window" }],
  pendingRemovals: [{ item: "FAKE_FORMER_PARTNER_LLC", requestedAt: "2026-08-20T15:00:00Z", eligibleAt: "2026-09-19T15:00:00Z", reason: "relationship ended" }],
});

const MID = utc("2026-09-10T14:00:00Z"); // after asOf, before the cooling eligibleAt, not in the blackout
const AFTER_COOLING = utc("2026-09-25T14:00:00Z");
const IN_BLACKOUT = utc("2026-10-05T14:00:00Z");
const STALE = utc("2026-12-01T14:00:00Z");

// Defaults: a new-risk decision, identity resolved to the symbol alone, known-empty look-through, generous age.
function check(over: Partial<ComplianceInput> & { symbol: string }): string[] {
  const input: ComplianceInput = { restrictedList: RL, now: MID, isNewRisk: true, maxListAgeDays: 120, themeExposures: [], identifiers: [over.symbol], ...over };
  return evaluateCompliance(input).violations.map((v) => v.code);
}

describe("evaluateCompliance", () => {
  it("admits a candidate on no list, with a known-empty look-through, outside any blackout", () => {
    const input: ComplianceInput = { symbol: "VTI", identifiers: ["VTI"], restrictedList: RL, now: MID, isNewRisk: true, maxListAgeDays: 120, themeExposures: [] };
    const r = evaluateCompliance(input);
    expect(r.admitted).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("gates NEW exposure only: a reduction of a restricted holding is always compliance-clear", () => {
    // FAKEAG is on the restricted ETFs list, but a reduction/exit (isNewRisk false) must never be trapped.
    expect(check({ symbol: "FAKEAG", isNewRisk: false })).toEqual([]);
    expect(check({ symbol: "FAKEAG", isNewRisk: true })).toContain("RESTRICTED_ETF");
  });

  it("rejects a new-risk restricted ETF and restricted name (additions are immediate)", () => {
    expect(check({ symbol: "FAKEAG" })).toContain("RESTRICTED_ETF");
    expect(check({ symbol: "FAKE_EMPLOYER_CO" })).toContain("RESTRICTED_NAME");
  });

  it("matches a restricted entity under any of its resolved identifiers (ticker change)", () => {
    // A company changed ticker; the restricted list still carries the old id, in the resolved identifier set.
    expect(check({ symbol: "NEWTICK", identifiers: ["NEWTICK", "FAKE_EMPLOYER_CO"] })).toContain("RESTRICTED_NAME");
    // And an identifier set resolved to only the new ticker does not match the old id: identity is the caller's to resolve.
    expect(check({ symbol: "NEWTICK", identifiers: ["NEWTICK"] })).not.toContain("RESTRICTED_NAME");
  });

  it("rejects a candidate exposed to a restricted theme", () => {
    expect(check({ symbol: "XLE", themeExposures: ["soybean_processing"] })).toContain("RESTRICTED_THEME");
  });

  it("blocks new risk when ETF look-through has not run (unknown state)", () => {
    expect(check({ symbol: "XLE", themeExposures: undefined })).toContain("UNKNOWN_LOOK_THROUGH");
  });

  it("keeps an item restricted through its cooling period, then releases it", () => {
    expect(check({ symbol: "FAKE_FORMER_PARTNER_LLC", now: MID })).toContain("RESTRICTED_COOLING");
    expect(check({ symbol: "FAKE_FORMER_PARTNER_LLC", now: AFTER_COOLING })).not.toContain("RESTRICTED_COOLING");
  });

  it("cannot have its cooling shortened by a too-early eligibleAt", () => {
    // eligibleAt is set (wrongly) to the same day as the request; cooling must still run 30 days from requestedAt.
    const rl = RestrictedListConfigSchema.parse({
      asOf: "2026-09-01",
      coolingPeriodDays: 30,
      pendingRemovals: [{ item: "SHADY", requestedAt: "2026-09-01T00:00:00Z", eligibleAt: "2026-09-01T00:00:01Z", reason: "too-early eligibility" }],
    });
    // 10 days after the request is still inside the 30-day interval, despite the tiny eligibleAt.
    const codes = evaluateCompliance({ symbol: "SHADY", identifiers: ["SHADY"], restrictedList: rl, now: utc("2026-09-11T00:00:00Z"), isNewRisk: true, maxListAgeDays: 120, themeExposures: [] }).violations.map((v) => v.code);
    expect(codes).toContain("RESTRICTED_COOLING");
  });

  it("blocks new risk during a blackout window but not risk-reducing actions", () => {
    expect(check({ symbol: "VTI", now: IN_BLACKOUT, isNewRisk: true })).toContain("BLACKOUT");
    expect(check({ symbol: "VTI", now: IN_BLACKOUT, isNewRisk: false })).not.toContain("BLACKOUT");
  });

  it("fails closed for new risk when the restricted list is stale, but still permits reductions", () => {
    expect(check({ symbol: "VTI", now: STALE, maxListAgeDays: 30 })).toContain("RESTRICTED_LIST_STALE");
    expect(check({ symbol: "VTI", now: STALE, maxListAgeDays: 30, isNewRisk: false })).toEqual([]);
    expect(check({ symbol: "VTI", now: MID, maxListAgeDays: 30 })).not.toContain("RESTRICTED_LIST_STALE");
  });
});
