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

function check(over: Partial<ComplianceInput> & { symbol: string }): string[] {
  const input: ComplianceInput = { restrictedList: RL, now: MID, isNewRisk: true, ...over };
  return evaluateCompliance(input).violations.map((v) => v.code);
}

describe("evaluateCompliance", () => {
  it("admits a candidate on no list, with no restricted theme, outside any blackout", () => {
    const r = evaluateCompliance({ symbol: "VTI", restrictedList: RL, now: MID, isNewRisk: true });
    expect(r.admitted).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("rejects a restricted ETF and a restricted name (additions are immediate)", () => {
    expect(check({ symbol: "FAKEAG" })).toContain("RESTRICTED_ETF");
    expect(check({ symbol: "FAKE_EMPLOYER_CO" })).toContain("RESTRICTED_NAME");
  });

  it("rejects a candidate exposed to a restricted theme", () => {
    expect(check({ symbol: "XLE", themeExposures: ["soybean_processing"] })).toContain("RESTRICTED_THEME");
  });

  it("keeps an item restricted through its cooling period, then releases it", () => {
    // Removal requested but not yet eligible.
    expect(check({ symbol: "FAKE_FORMER_PARTNER_LLC", now: MID })).toContain("RESTRICTED_COOLING");
    // Past eligibleAt: no longer restricted by the pending removal.
    expect(check({ symbol: "FAKE_FORMER_PARTNER_LLC", now: AFTER_COOLING })).not.toContain("RESTRICTED_COOLING");
  });

  it("blocks new risk during a blackout window but not risk-reducing actions", () => {
    expect(check({ symbol: "VTI", now: IN_BLACKOUT, isNewRisk: true })).toContain("BLACKOUT");
    expect(check({ symbol: "VTI", now: IN_BLACKOUT, isNewRisk: false })).not.toContain("BLACKOUT");
  });

  it("fails closed when the restricted list is stale beyond the allowed age", () => {
    expect(check({ symbol: "VTI", now: STALE, maxListAgeDays: 30 })).toContain("RESTRICTED_LIST_STALE");
    // Fresh enough: no staleness violation.
    expect(check({ symbol: "VTI", now: MID, maxListAgeDays: 30 })).not.toContain("RESTRICTED_LIST_STALE");
  });
});
