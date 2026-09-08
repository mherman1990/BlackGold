import { evaluateHaltState, type HaltDecision, type HaltInput, type RiskState } from "../risk/halt.ts";
import { evaluateRiskLimits, type RiskLimitsInput, type RiskVerdict } from "../risk/limits.ts";
import { evaluateCompliance, type ComplianceInput, type ComplianceVerdict } from "../compliance/engine.ts";

/**
 * The deterministic decision gate (docs/PRODUCT_SPEC.md section 8; PLAN.md Phase 5 - "100% hard-rule
 * enforcement").
 *
 * This is the single place that composes the three independent verdicts into one go/no-go for NEW RISK:
 *
 *   new risk may proceed  ==  halt state is NORMAL  AND  the proposed book respects every limit  AND
 *                             every candidate newly taking risk clears compliance
 *
 * It is fail-closed by construction: a single block from any engine makes `newRiskAllowed` false, and the
 * blocking reasons are flattened for the decision record. It forms no order and it never re-sizes - it decides
 * whether the deterministically-constructed target may be acted on. The equivalent guards run again in the
 * broker gateway; this is the core-side gate.
 *
 * Purely deterministic: it composes only the risk and compliance engines (all under `risk/` and `compliance/`,
 * which the analyst layer is forbidden to import), so no model output can reach the decision (threat model
 * T-05). Model confidence is display metadata elsewhere and is absent here by construction.
 *
 * Compliance is always evaluated as NEW RISK for each supplied candidate - the gate's whole question is whether
 * new exposure may be added - so the candidate inputs omit `isNewRisk` and the gate fixes it to `true`.
 */

export type CandidateCompliance = { symbol: string; verdict: ComplianceVerdict };

export type DecisionGateInput = {
  /** Inputs for the halt-state machine (portfolio snapshot, staleness/incident signals, thresholds). */
  halt: HaltInput;
  /** Inputs for the risk-limit guard (the proposed target book + policy + charter). */
  limits: RiskLimitsInput;
  /** The candidates newly taking or increasing risk this decision. Each is checked as new-risk compliance. */
  newRiskCandidates: readonly Omit<ComplianceInput, "isNewRisk">[];
};

export type DecisionGateVerdict = {
  /**
   * True iff the halt state is NORMAL, the proposed book respects every limit, and every new-risk candidate
   * clears compliance. Fail-closed: any single block makes this false.
   */
  newRiskAllowed: boolean;
  haltState: RiskState;
  halt: HaltDecision;
  limits: RiskVerdict;
  compliance: CandidateCompliance[];
  /** Every blocking reason across the three engines, flattened, for the decision ledger. Empty when allowed. */
  blockedBy: string[];
};

export function evaluateDecisionGate(input: DecisionGateInput): DecisionGateVerdict {
  const halt = evaluateHaltState(input.halt);
  const limits = evaluateRiskLimits(input.limits);
  const compliance: CandidateCompliance[] = input.newRiskCandidates.map((c) => ({
    symbol: c.symbol,
    verdict: evaluateCompliance({ ...c, isNewRisk: true }),
  }));

  // New risk requires the steady state: HALT_NEW_RISK, HOLD_ONLY, and EMERGENCY_FLATTEN all forbid it.
  const haltAllowsNewRisk = halt.state === "NORMAL";
  const complianceOk = compliance.every((c) => c.verdict.admitted);
  const newRiskAllowed = haltAllowsNewRisk && limits.admitted && complianceOk;

  const blockedBy: string[] = [];
  if (!haltAllowsNewRisk) {
    const cause = halt.faults.length > 0 ? `: ${halt.faults.map((f) => f.code).join(", ")}` : "";
    blockedBy.push(`halt state ${halt.state} does not permit new risk${cause}`);
  }
  for (const v of limits.violations) blockedBy.push(`limit ${v.code}: ${v.detail}`);
  for (const c of compliance) for (const v of c.verdict.violations) blockedBy.push(`compliance ${c.symbol} ${v.code}: ${v.detail}`);

  return { newRiskAllowed, haltState: halt.state, halt, limits, compliance, blockedBy };
}
