import { Dec, type UtcInstant } from "@blackgold/shared";
import type { RiskConfig } from "../config/schema.ts";

/**
 * The deterministic halt-state machine (docs/PRODUCT_SPEC.md section 8; docs/AUTOMATION_AND_LIVE_GATES.md
 * "halt state machine"; CLAUDE.md non-negotiables).
 *
 * This is the core risk safety property in code form, and every rule here is one CLAUDE.md states as
 * non-negotiable:
 *
 * - A drawdown, daily loss, stale critical input, expired authorization, or severe incident lands the system
 *   in `HALT_NEW_RISK`, never in an automatic liquidation. `automaticFlatten` is `false` by schema and this
 *   engine never returns `EMERGENCY_FLATTEN_AUTHORIZED` from a fault - that state is entered by the owner alone
 *   and expires automatically at the end of its session (section 9.3).
 * - Reconciliation, order-state, or broker uncertainty demands `HOLD_ONLY`, not merely `HALT_NEW_RISK`: nothing
 *   may proceed against a book whose picture is not reconciled (sections 7 and 8).
 * - Transitions toward a MORE restrictive state are automatic; a transition toward a LESS restrictive one
 *   happens only on an explicit owner re-arm, is staged one step at a time (`HOLD_ONLY` -> `HALT_NEW_RISK` ->
 *   `NORMAL`, section 9.2), and even then an active fault still binds (you cannot re-arm to NORMAL while the
 *   drawdown that halted you persists).
 * - Unknown or unclassified state fails closed: absent portfolio numbers are treated as a fault, not as "all
 *   clear".
 *
 * Pure by design: it reads only numbers, booleans, and the policy - never a model, a broker, or the network
 * (threat model T-05; the eslint boundary forbids the analyst layer from importing anything under `risk/`).
 * The caller logs the returned transition to the event ledger with cause, actor, and timestamp.
 */

export const RISK_STATES = ["NORMAL", "HALT_NEW_RISK", "HOLD_ONLY", "EMERGENCY_FLATTEN_AUTHORIZED"] as const;
export type RiskState = (typeof RISK_STATES)[number];

/** Restrictiveness of the three fault-reachable states. `EMERGENCY_FLATTEN_AUTHORIZED` is owner-only and out of band. */
const FAULT_RANK: Record<"NORMAL" | "HALT_NEW_RISK" | "HOLD_ONLY", number> = { NORMAL: 0, HALT_NEW_RISK: 1, HOLD_ONLY: 2 };
type FaultState = keyof typeof FAULT_RANK;
const BY_RANK: readonly FaultState[] = ["NORMAL", "HALT_NEW_RISK", "HOLD_ONLY"];
const fromRank = (r: number): FaultState => BY_RANK[Math.min(Math.max(r, 0), BY_RANK.length - 1)] ?? "HOLD_ONLY";

export type Fault = {
  code: string;
  detail: string;
  /** The least state this fault demands. Never `EMERGENCY_FLATTEN_AUTHORIZED`. */
  demands: FaultState;
};

/** Sleeve accounting the halt check needs. Absent (`undefined`) means unknown, which fails closed. */
export type PortfolioSnapshot = {
  nav: Dec;
  highWaterMark: Dec;
  sessionStartNav: Dec;
};

export type IncidentSignal = { id: string; severity: "low" | "medium" | "high" | "critical" };

export type HaltInput = {
  policy: RiskConfig;
  /** The persisted current state. The engine escalates from here and never silently relaxes it. */
  current: RiskState;
  /** Sleeve NAV, high-water mark, and session-start NAV. `undefined` is an unknown-state fault. */
  portfolio: PortfolioSnapshot | undefined;
  /** Names of critical inputs that are stale or missing (e.g. `market_data`, `financial_picture`, `broker_auth`). */
  staleInputs?: readonly string[];
  incidents?: readonly IncidentSignal[];
  /** Broker state cannot be trusted. Order/reconciliation uncertainty demands HOLD_ONLY, not merely HALT_NEW_RISK. */
  unknownBrokerState?: boolean;
  /** A reconciliation break unresolved past one session (AUTOMATION_AND_LIVE_GATES section 8) -> HOLD_ONLY. */
  reconciliationUnresolved?: boolean;
  /** An order was submitted with no acknowledgement -> HOLD_ONLY until its state is resolved. */
  uncertainOrderState?: boolean;
  /** Core and gateway disagree on mode or halt state -> HOLD_ONLY (the more restrictive picture wins). */
  coreGatewayDisagree?: boolean;
  authorizationExpired?: boolean;
  unapprovedVersionChange?: boolean;
  /** True when the owner-entered emergency-flatten authorization's session has ended; it then expires (section 9.3). */
  emergencyFlattenExpired?: boolean;
  /**
   * An explicit owner action to relax the state. Relaxation is staged - at most one step less restrictive per
   * re-arm (HOLD_ONLY -> HALT_NEW_RISK -> NORMAL; section 9.2) - and an active fault still binds.
   */
  ownerReArm?: { to: FaultState; actor: string; at: UtcInstant } | undefined;
};

export type HaltDecision = {
  state: RiskState;
  from: RiskState;
  /** Every active fault, for the ledger record. Empty when nothing is wrong. */
  faults: Fault[];
  /** True whenever the resulting state is more restrictive than NORMAL; returning to NORMAL needs an owner re-arm. */
  requiresManualReArm: boolean;
  /** Always false. Present so the audit line can state, on every evaluation, that no automatic flatten occurred. */
  automaticFlatten: false;
};

function moreRestrictive(a: FaultState, b: FaultState): FaultState {
  return FAULT_RANK[a] >= FAULT_RANK[b] ? a : b;
}

/** Collect every active fault and the state each demands. Order is stable for a deterministic ledger record. */
function collectFaults(input: HaltInput): Fault[] {
  const faults: Fault[] = [];
  const h = input.policy.haltThresholds;

  if (input.portfolio === undefined) {
    faults.push({ code: "UNKNOWN_STATE", detail: "portfolio snapshot is unavailable; failing closed for new risk", demands: "HALT_NEW_RISK" });
  } else {
    const { nav, highWaterMark, sessionStartNav } = input.portfolio;
    if (!highWaterMark.gt(0)) {
      faults.push({ code: "UNKNOWN_HIGH_WATER_MARK", detail: "high-water mark is not positive; drawdown cannot be computed", demands: "HALT_NEW_RISK" });
    } else {
      const drawdown = highWaterMark.minus(nav).div(highWaterMark);
      if (drawdown.gte(new Dec(h.holdOnlyDrawdownPct))) {
        faults.push({ code: "DRAWDOWN_HOLD_ONLY", detail: `drawdown ${drawdown.toFixed(4)} at or beyond hold-only ${h.holdOnlyDrawdownPct}`, demands: "HOLD_ONLY" });
      } else if (drawdown.gte(new Dec(h.haltNewRiskDrawdownPct))) {
        faults.push({ code: "DRAWDOWN_HALT_NEW_RISK", detail: `drawdown ${drawdown.toFixed(4)} at or beyond halt ${h.haltNewRiskDrawdownPct}`, demands: "HALT_NEW_RISK" });
      }
    }
    if (!sessionStartNav.gt(0)) {
      faults.push({ code: "UNKNOWN_SESSION_START_NAV", detail: "session-start NAV is not positive; daily loss cannot be computed", demands: "HALT_NEW_RISK" });
    } else {
      const dailyLoss = sessionStartNav.minus(nav).div(sessionStartNav);
      if (dailyLoss.gte(new Dec(h.dailyLossPct))) {
        faults.push({ code: "DAILY_LOSS_HALT", detail: `session loss ${dailyLoss.toFixed(4)} at or beyond ${h.dailyLossPct}`, demands: "HALT_NEW_RISK" });
      }
    }
  }

  for (const name of input.staleInputs ?? []) {
    faults.push({ code: "STALE_INPUT", detail: `critical input '${name}' is stale or missing`, demands: "HALT_NEW_RISK" });
  }
  // Broker, reconciliation, and order-state uncertainty demand HOLD_ONLY: nothing may proceed against a book
  // whose picture is not reconciled (AUTOMATION_AND_LIVE_GATES.md 7 and 8).
  if (input.unknownBrokerState === true) faults.push({ code: "UNKNOWN_BROKER_STATE", detail: "broker state is unknown; hold until reconciled", demands: "HOLD_ONLY" });
  if (input.reconciliationUnresolved === true) faults.push({ code: "RECONCILIATION_UNRESOLVED", detail: "a reconciliation break is unresolved past one session", demands: "HOLD_ONLY" });
  if (input.uncertainOrderState === true) faults.push({ code: "UNCERTAIN_ORDER_STATE", detail: "an order was submitted with no acknowledgement", demands: "HOLD_ONLY" });
  if (input.coreGatewayDisagree === true) faults.push({ code: "CORE_GATEWAY_DISAGREE", detail: "core and gateway disagree on mode or halt state", demands: "HOLD_ONLY" });
  if (input.authorizationExpired === true) faults.push({ code: "AUTHORIZATION_EXPIRED", detail: "live authorization is expired or missing", demands: "HALT_NEW_RISK" });
  if (input.unapprovedVersionChange === true) faults.push({ code: "UNAPPROVED_VERSION_CHANGE", detail: "an unapproved version change was detected", demands: "HALT_NEW_RISK" });
  for (const inc of input.incidents ?? []) {
    // "HALT_NEW_RISK or HOLD_ONLY per incident class" (section 8): a critical incident holds everything.
    if (inc.severity === "critical") faults.push({ code: "SEVERE_INCIDENT", detail: `incident ${inc.id} at severity critical`, demands: "HOLD_ONLY" });
    else if (inc.severity === "high") faults.push({ code: "SEVERE_INCIDENT", detail: `incident ${inc.id} at severity high`, demands: "HALT_NEW_RISK" });
  }
  return faults;
}

/**
 * Compute the halt state from the current state, the active faults, and any owner re-arm. See the module
 * comment for the invariants; the returned decision is what the caller records to the ledger.
 */
export function evaluateHaltState(input: HaltInput): HaltDecision {
  const faults = collectFaults(input);
  const faultFloor = faults.reduce<FaultState>((acc, f) => moreRestrictive(acc, f.demands), "NORMAL");

  let state: RiskState;
  if (input.current === "EMERGENCY_FLATTEN_AUTHORIZED") {
    if (input.emergencyFlattenExpired === true) {
      // Scheduled expiry at session end (section 9.3): the owner state ends on its own and the system lands
      // in at least HALT_NEW_RISK (mode drops to PAPER; re-entering live needs a fresh promotion review). A
      // scheduled expiry is a legitimate automatic transition, not an owner re-arm.
      state = moreRestrictive("HALT_NEW_RISK", faultFloor);
    } else {
      // Still authorized this session; the fault engine neither leaves nor deepens it. Faults are still
      // recorded so the ledger shows what was true while flattening.
      state = "EMERGENCY_FLATTEN_AUTHORIZED";
    }
  } else if (input.ownerReArm !== undefined) {
    // Relaxation is staged: an owner re-arm may reduce restrictiveness by at most one step (section 9.2), so a
    // HOLD_ONLY cannot jump straight to NORMAL. And an active fault still binds, so a request below the fault
    // floor is clamped up to it. `input.current` is one of the three fault states here.
    const oneStepFloor = FAULT_RANK[input.current] - 1;
    const requested = Math.max(FAULT_RANK[input.ownerReArm.to], oneStepFloor);
    state = fromRank(Math.max(requested, FAULT_RANK[faultFloor]));
  } else {
    // No owner action: escalate to the fault floor if it is more restrictive, never relax below the current
    // state on our own. `input.current` is one of the three fault states here (EMERGENCY_FLATTEN is handled above).
    state = moreRestrictive(input.current, faultFloor);
  }

  const requiresManualReArm = state !== "NORMAL";
  return { state, from: input.current, faults, requiresManualReArm, automaticFlatten: false };
}
