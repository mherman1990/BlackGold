import { describe, expect, it } from "vitest";
import { Dec, utc } from "@blackgold/shared";
import { RiskConfigSchema, type RiskConfig } from "../src/config/schema.ts";
import { evaluateHaltState, type PortfolioSnapshot } from "../src/risk/halt.ts";

const POLICY: RiskConfig = RiskConfigSchema.parse({});
const AT = utc("2026-09-08T14:00:00Z");

/** nav, high-water mark, session-start nav. Defaults are a flat, healthy book. */
function pf(nav: number, hwm = 100, start = 100): PortfolioSnapshot {
  return { nav: new Dec(nav), highWaterMark: new Dec(hwm), sessionStartNav: new Dec(start) };
}

describe("evaluateHaltState", () => {
  it("stays NORMAL with a healthy book and no faults", () => {
    const d = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(100) });
    expect(d.state).toBe("NORMAL");
    expect(d.faults).toEqual([]);
    expect(d.requiresManualReArm).toBe(false);
    expect(d.automaticFlatten).toBe(false);
  });

  it("halts new risk at the drawdown threshold (boundary, gte)", () => {
    // 8% drawdown from the high-water mark: exactly at haltNewRiskDrawdownPct.
    const d = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(92) });
    expect(d.state).toBe("HALT_NEW_RISK");
    expect(d.faults.map((f) => f.code)).toContain("DRAWDOWN_HALT_NEW_RISK");
  });

  it("escalates to HOLD_ONLY at the deeper drawdown threshold", () => {
    const d = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(90) });
    expect(d.state).toBe("HOLD_ONLY");
    expect(d.faults.map((f) => f.code)).toContain("DRAWDOWN_HOLD_ONLY");
  });

  it("halts new risk on a daily loss even when drawdown is shallow", () => {
    // nav 98 vs hwm 100 is only 2% drawdown (below the 8% halt), but 2% down on the session.
    const d = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(98, 100, 100) });
    expect(d.state).toBe("HALT_NEW_RISK");
    expect(d.faults.map((f) => f.code)).toContain("DAILY_LOSS_HALT");
  });

  it("fails closed when the portfolio snapshot is unknown", () => {
    const d = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: undefined });
    expect(d.state).toBe("HALT_NEW_RISK");
    expect(d.faults.map((f) => f.code)).toEqual(["UNKNOWN_STATE"]);
  });

  it("fails closed on a non-positive high-water mark rather than dividing by zero", () => {
    const d = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(100, 0, 100) });
    expect(d.state).toBe("HALT_NEW_RISK");
    expect(d.faults.map((f) => f.code)).toContain("UNKNOWN_HIGH_WATER_MARK");
  });

  it("halts new risk on a stale critical input", () => {
    const d = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(100), staleInputs: ["market_data"] });
    expect(d.state).toBe("HALT_NEW_RISK");
    expect(d.faults[0]?.detail).toContain("market_data");
  });

  it("halts new risk on a severe incident but ignores a low-severity one", () => {
    const severe = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(100), incidents: [{ id: "I-1", severity: "high" }] });
    expect(severe.state).toBe("HALT_NEW_RISK");
    const minor = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(100), incidents: [{ id: "I-2", severity: "low" }] });
    expect(minor.state).toBe("NORMAL");
  });

  it("halts new risk on expired authorization or an unapproved version change", () => {
    expect(evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(100), authorizationExpired: true }).state).toBe("HALT_NEW_RISK");
    expect(evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(100), unapprovedVersionChange: true }).state).toBe("HALT_NEW_RISK");
  });

  it("takes the most restrictive state when several faults are active", () => {
    // Deep drawdown (HOLD_ONLY) together with a daily-loss halt (HALT_NEW_RISK) -> HOLD_ONLY wins.
    const d = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(90, 100, 92) });
    expect(d.state).toBe("HOLD_ONLY");
    expect(d.faults.map((f) => f.code)).toEqual(expect.arrayContaining(["DRAWDOWN_HOLD_ONLY", "DAILY_LOSS_HALT"]));
  });

  it("never relaxes automatically: a halted state with faults cleared stays halted", () => {
    const d = evaluateHaltState({ policy: POLICY, current: "HALT_NEW_RISK", portfolio: pf(100) });
    expect(d.state).toBe("HALT_NEW_RISK");
    expect(d.faults).toEqual([]);
    expect(d.requiresManualReArm).toBe(true);
  });

  it("returns to NORMAL only on an owner re-arm once faults are clear", () => {
    const d = evaluateHaltState({
      policy: POLICY,
      current: "HALT_NEW_RISK",
      portfolio: pf(100),
      ownerReArm: { to: "NORMAL", actor: "matt", at: AT },
    });
    expect(d.state).toBe("NORMAL");
  });

  it("refuses an owner re-arm below what an active fault still demands", () => {
    // Owner tries to re-arm to NORMAL while a drawdown breach is still live: the fault binds.
    const d = evaluateHaltState({
      policy: POLICY,
      current: "HALT_NEW_RISK",
      portfolio: pf(92),
      ownerReArm: { to: "NORMAL", actor: "matt", at: AT },
    });
    expect(d.state).toBe("HALT_NEW_RISK");
  });

  it("never enters EMERGENCY_FLATTEN from a fault, and leaves an owner-set one alone", () => {
    // No fault path produces EMERGENCY_FLATTEN...
    const escalated = evaluateHaltState({ policy: POLICY, current: "NORMAL", portfolio: pf(80) });
    expect(escalated.state).not.toBe("EMERGENCY_FLATTEN_AUTHORIZED");
    // ...and an owner-set flatten is not changed by the fault engine, though faults are still recorded.
    const held = evaluateHaltState({ policy: POLICY, current: "EMERGENCY_FLATTEN_AUTHORIZED", portfolio: pf(80) });
    expect(held.state).toBe("EMERGENCY_FLATTEN_AUTHORIZED");
    expect(held.faults.length).toBeGreaterThan(0);
    expect(held.automaticFlatten).toBe(false);
  });
});
