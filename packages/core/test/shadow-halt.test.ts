import { describe, expect, it } from "vitest";
import { isoDate, type UtcInstant } from "@blackgold/shared";
import { shadowHaltContext, type ReconcileObservation, type ShadowReArm } from "../src/decision/shadow-halt.ts";

// Decision instant: Friday 2026-03-20, close + 60 min. Reconciles run after each close.
const DECISION_AT = "2026-03-20T21:00:00.000Z" as UtcInstant;
const SESSION = isoDate("2026-03-20");
const at = (s: string): UtcInstant => `${s}T22:30:00.000Z` as UtcInstant;
const rec = (session: string, breaks: string[], when: UtcInstant = at(session)): ReconcileObservation => ({ session: isoDate(session), at: when, breaks });
const rearm = (to: ShadowReArm["to"], when: UtcInstant, acknowledgedBreaks: string[] = []): ShadowReArm => ({ to, actor: "Owner", at: when, reason: "reviewed", acknowledgedBreaks });
const BREAK = "UNFILLED_REMAINDER:B0_PASSIVE:2026-03-06T21:00:00.000Z:VTI";

const ctx = (opts: { reconciles?: ReconcileObservation[]; reArms?: ShadowReArm[]; previous?: Parameters<typeof shadowHaltContext>[0]["previous"] }) =>
  shadowHaltContext({ previous: opts.previous, reconciles: opts.reconciles ?? [], reArms: opts.reArms ?? [], decisionAt: DECISION_AT, decisionSession: SESSION });

describe("shadowHaltContext: reconciliation breaks", () => {
  it("demands action only for a break reported on a session BEFORE the decision's and still reported", () => {
    const c = ctx({ reconciles: [rec("2026-03-13", [BREAK]), rec("2026-03-16", [BREAK]), rec("2026-03-19", [BREAK])] });
    expect(c.unresolvedBreaks).toEqual([BREAK]);
    expect(c.freshBreaks).toEqual([]);
  });

  it("treats a break first reported at the decision session itself as fresh, not yet unresolved (boundary)", () => {
    // A reconcile dated the decision session but known before the instant (it ran early in this fixture).
    const c = ctx({ reconciles: [rec("2026-03-19", []), rec("2026-03-20", [BREAK], "2026-03-20T20:30:00.000Z" as UtcInstant)] });
    expect(c.unresolvedBreaks).toEqual([]);
    expect(c.freshBreaks).toEqual([BREAK]);
  });

  it("ignores a reconcile recorded after the decision instant (knowledge-scoped)", () => {
    const c = ctx({ reconciles: [rec("2026-03-13", []), rec("2026-03-19", [BREAK], "2026-03-20T21:00:00.001Z" as UtcInstant)] });
    expect(c.unresolvedBreaks).toEqual([]);
    expect(c.freshBreaks).toEqual([]);
  });

  it("drops a break the latest reconcile no longer reports (it genuinely resolved)", () => {
    const c = ctx({ reconciles: [rec("2026-03-13", [BREAK]), rec("2026-03-19", [])] });
    expect(c.unresolvedBreaks).toEqual([]);
  });

  it("restarts the clock for a break that cleared and came back", () => {
    const c = ctx({ reconciles: [rec("2026-03-13", [BREAK]), rec("2026-03-16", []), rec("2026-03-20", [BREAK], "2026-03-20T20:30:00.000Z" as UtcInstant)] });
    expect(c.freshBreaks).toEqual([BREAK]); // first seen again on the decision session, not on 03-13
    expect(c.unresolvedBreaks).toEqual([]);
  });
});

describe("shadowHaltContext: owner acknowledgements", () => {
  const reconciles = [rec("2026-03-13", [BREAK]), rec("2026-03-19", [BREAK])];

  it("excludes a break the owner acknowledged after it was reported", () => {
    const c = ctx({ reconciles, reArms: [rearm("HALT_NEW_RISK", "2026-03-19T23:00:00.000Z" as UtcInstant, [BREAK])] });
    expect(c.unresolvedBreaks).toEqual([]);
    expect(c.acknowledgedBreaks).toEqual([BREAK]);
  });

  it("does NOT honour an acknowledgement written before the break was ever reported (no pre-acknowledging)", () => {
    // The owner names the code on 03-12, before any reconcile reported it: that would silence a future fault.
    const c = ctx({ reconciles, reArms: [rearm("NORMAL", "2026-03-12T23:00:00.000Z" as UtcInstant, [BREAK])] });
    expect(c.unresolvedBreaks).toEqual([BREAK]);
    expect(c.acknowledgedBreaks).toEqual([]);
  });

  it("ignores a re-arm recorded after the decision instant", () => {
    const c = ctx({ reconciles, reArms: [rearm("HALT_NEW_RISK", "2026-03-20T21:00:00.001Z" as UtcInstant, [BREAK])] });
    expect(c.unresolvedBreaks).toEqual([BREAK]);
    expect(c.reArms).toEqual([]);
  });
});

describe("shadowHaltContext: the sticky state and the re-arm window", () => {
  it("starts from the previous decision's most restrictive recorded state, NORMAL before any", () => {
    expect(ctx({}).current).toBe("NORMAL");
    expect(ctx({ previous: { decisionAt: "2026-03-13T21:00:00.000Z" as UtcInstant, haltStates: ["HALT_NEW_RISK", "HOLD_ONLY"] } }).current).toBe("HOLD_ONLY");
    // The owner-only flatten state is never a fault state; reading it back fails closed to HOLD_ONLY.
    expect(ctx({ previous: { decisionAt: "2026-03-13T21:00:00.000Z" as UtcInstant, haltStates: ["EMERGENCY_FLATTEN_AUTHORIZED"] } }).current).toBe("HOLD_ONLY");
  });

  it("consumes only the re-arms issued after the previous decision instant, oldest first", () => {
    const previous = { decisionAt: "2026-03-13T21:00:00.000Z" as UtcInstant, haltStates: ["HOLD_ONLY" as const] };
    const early = rearm("HALT_NEW_RISK", "2026-03-13T20:00:00.000Z" as UtcInstant); // consumed by the previous decision
    const second = rearm("NORMAL", "2026-03-18T12:00:00.000Z" as UtcInstant);
    const first = rearm("HALT_NEW_RISK", "2026-03-16T12:00:00.000Z" as UtcInstant);
    expect(ctx({ previous, reArms: [second, early, first] }).reArms).toEqual([first, second]);
  });
});
