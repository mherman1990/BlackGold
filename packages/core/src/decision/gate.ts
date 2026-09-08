import { ZERO, type Dec } from "@blackgold/shared";
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
 *                             every holding taking new or increased risk clears compliance
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
 *
 * Compliance COVERAGE is enforced, not trusted. The gate derives which holdings are taking new or increased
 * risk from the target book against the current book (`target > current`), and requires a supplied compliance
 * evaluation for every one of them. A holding whose weight increases with no matching candidate fails closed
 * (`MISSING_COMPLIANCE`): the gate must never admit new exposure it has not checked, and it cannot rely on the
 * caller to have remembered to submit it. Holdings that are held flat or reduced are not new risk and need no
 * candidate - that is what keeps a restricted position windable-down without tripping the new-risk gate.
 */

export type CandidateCompliance = { symbol: string; verdict: ComplianceVerdict };

export type DecisionGateInput = {
  /** Inputs for the halt-state machine (portfolio snapshot, staleness/incident signals, thresholds). */
  halt: HaltInput;
  /** Inputs for the risk-limit guard (the proposed target book + policy + charter). */
  limits: RiskLimitsInput;
  /**
   * The book in force before this decision, keyed the same way as `limits.weights` (entity id). A holding whose
   * target weight exceeds its current weight is taking new risk this decision and must clear compliance; an
   * absent key is treated as zero, so a brand-new position counts as new risk. Pass an empty map when there is
   * no existing book: then every target holding is new risk, which is the fail-closed default.
   */
  currentWeights: ReadonlyMap<string, Dec>;
  /**
   * Compliance inputs for the holdings taking new or increased risk this decision. Each is checked as new-risk
   * compliance. Coverage is enforced against the target/current delta: every increasing holding must be
   * represented here (matched by symbol, entity id, or any resolved identifier) or the gate fails closed.
   */
  newRiskCandidates: readonly Omit<ComplianceInput, "isNewRisk">[];
};

export type DecisionGateVerdict = {
  /**
   * True iff the halt state is NORMAL, the proposed book respects every limit, every new-risk candidate clears
   * compliance, and every increasing holding is covered by a candidate. Fail-closed: any single block makes
   * this false.
   */
  newRiskAllowed: boolean;
  haltState: RiskState;
  halt: HaltDecision;
  limits: RiskVerdict;
  compliance: CandidateCompliance[];
  /** The holdings whose target weight exceeds their current weight: the set that must clear compliance. */
  increasedRisk: string[];
  /** Every blocking reason across the three engines, flattened, for the decision ledger. Empty when allowed. */
  blockedBy: string[];
};

export function evaluateDecisionGate(input: DecisionGateInput): DecisionGateVerdict {
  const halt = evaluateHaltState(input.halt);
  const limits = evaluateRiskLimits(input.limits);

  // Evaluate every supplied candidate as new risk, and index it under all of its resolved identifiers so a
  // holding keyed in the book by entity id is matched by a candidate carrying that id as symbol, entityId, or
  // any identifier. First writer wins; a duplicate id does not overwrite an earlier candidate.
  const byId = new Map<string, CandidateCompliance>();
  const compliance: CandidateCompliance[] = input.newRiskCandidates.map((c) => {
    const entry: CandidateCompliance = { symbol: c.symbol, verdict: evaluateCompliance({ ...c, isNewRisk: true }) };
    const ids = new Set<string>([c.symbol, ...c.identifiers, ...(c.entityId === undefined ? [] : [c.entityId])]);
    for (const id of ids) if (!byId.has(id)) byId.set(id, entry);
    return entry;
  });

  // The holdings taking new or increased risk this decision: target weight strictly above current weight.
  // A brand-new position (current absent => zero) and an increase both count; a hold or reduction does not.
  const increasedRisk: string[] = [];
  const uncovered: string[] = [];
  for (const [id, target] of input.limits.weights) {
    const current = input.currentWeights.get(id) ?? ZERO;
    if (target.gt(current)) {
      increasedRisk.push(id);
      if (!byId.has(id)) uncovered.push(id);
    }
  }
  increasedRisk.sort();
  uncovered.sort();

  // New risk requires the steady state: HALT_NEW_RISK, HOLD_ONLY, and EMERGENCY_FLATTEN all forbid it.
  const haltAllowsNewRisk = halt.state === "NORMAL";
  const complianceOk = compliance.every((c) => c.verdict.admitted);
  const coverageOk = uncovered.length === 0;
  const newRiskAllowed = haltAllowsNewRisk && limits.admitted && complianceOk && coverageOk;

  const blockedBy: string[] = [];
  if (!haltAllowsNewRisk) {
    // One reason per fault, keeping each fault's detail (two faults sharing a code identify different causes),
    // to match the code+detail shape the limit and compliance reasons already use. A non-NORMAL state with no
    // active fault (e.g. carried from a prior state) still records a reason so the block is never silent.
    if (halt.faults.length === 0) blockedBy.push(`halt state ${halt.state} does not permit new risk`);
    else for (const f of halt.faults) blockedBy.push(`halt ${f.code}: ${f.detail}`);
  }
  for (const v of limits.violations) blockedBy.push(`limit ${v.code}: ${v.detail}`);
  for (const c of compliance) for (const v of c.verdict.violations) blockedBy.push(`compliance ${c.symbol} ${v.code}: ${v.detail}`);
  for (const id of uncovered) {
    blockedBy.push(`compliance ${id} MISSING_COMPLIANCE: target weight increases but no new-risk compliance evaluation was supplied`);
  }

  return { newRiskAllowed, haltState: halt.state, halt, limits, compliance, increasedRisk, blockedBy };
}
