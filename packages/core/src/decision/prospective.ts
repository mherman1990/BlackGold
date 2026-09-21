import { Dec, ONE, ZERO, type Arm, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { ReadOnlyPointInTime } from "../data/pit/types.ts";
import { computeFeatures, featureParamsFromCharter } from "../strategy/features.ts";
import { candidateParamsFromCharter, selectCandidates } from "../strategy/candidates.ts";
import { constructTargets, sizingParamsFromCharter } from "../strategy/construct.ts";
import { admittedRiskEtfs, type Charter } from "../strategy/charter.ts";

/**
 * Per-arm deterministic target book at one prospective decision instant (D-53 slice 2).
 *
 * The prospective (SHADOW/PAPER) decision loop and the historical backtest MUST make the same decision from the
 * same point-in-time reads, or the shadow evidence would describe a different system than the one that was
 * backtested. So this module composes exactly the shared, leakage-audited primitives the backtest composes -
 * `computeFeatures` -> `selectCandidates` -> `constructTargets` - rather than re-deriving any signal or sizing
 * logic. A permanent cross-check test binds B1's target weights here to `runBacktest`'s at the same instant.
 *
 * It reads only point-in-time (`asOf`, through {@link ReadOnlyPointInTime}, which cannot append or snapshot),
 * forms no order, and touches no broker. Turning a target book into a sealed `ProspectiveDecisionRecord` (with
 * the deterministic decision-gate verdict) is the next step; scheduling it is the step after that.
 */

export type DecisionEngineDeps = {
  /** The narrowed point-in-time read surface. `asOf` enforces `availableAt + processingDelay <= decisionAt`. */
  pit: ReadOnlyPointInTime;
  calendar: ExchangeCalendar;
  barsSourceId?: string;
  snapshotId?: string;
  processingDelayMs?: number;
};

/** One risk-ETF target weight as a fraction of NAV. */
export type ArmTargetWeight = { entityId: string; weight: Dec };

export type ArmTargetBook = {
  arm: Arm;
  decisionAt: UtcInstant;
  anchorSession: IsoDate;
  /** False when the anchor is a calendar fallback with NO admissible observation behind it (see FeatureSet). */
  anchorFromData: boolean;
  /** Target risk weights as fractions of NAV, sorted by entityId. The cash leg is `cashWeight`. Never dollars. */
  targetWeights: ArmTargetWeight[];
  /** `1 - sum(targetWeights)`, held in cash. */
  cashWeight: Dec;
  labels: string[];
};

/** Build the `computeFeatures` deps, passing only the keys that are set (exactOptionalPropertyTypes). */
function featureDeps(deps: DecisionEngineDeps) {
  return {
    pit: deps.pit,
    calendar: deps.calendar,
    ...(deps.barsSourceId === undefined ? {} : { barsSourceId: deps.barsSourceId }),
    ...(deps.snapshotId === undefined ? {} : { snapshotId: deps.snapshotId }),
    ...(deps.processingDelayMs === undefined ? {} : { processingDelayMs: deps.processingDelayMs }),
  };
}

function sortedByEntity(weights: ReadonlyMap<string, Dec>): ArmTargetWeight[] {
  return [...weights]
    .map(([entityId, weight]) => ({ entityId, weight }))
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
}

/**
 * The deterministic (B1) target book: features -> candidate selection -> sizing, the same composition and the
 * same charter-derived params `runBacktest` uses, so the prospective decision matches the backtested one at the
 * same instant. `held` is the entity set currently held (candidate hysteresis reads it); pass an empty set when
 * there is no book.
 */
export function deterministicTargetBook(charter: Charter, deps: DecisionEngineDeps, decisionAt: UtcInstant, held: ReadonlySet<string>): ArmTargetBook {
  const riskEntities = admittedRiskEtfs(charter);
  const cashEntityId = charter.universe.cash_etf;
  const fs = computeFeatures(featureDeps(deps), { riskEntities, cashEntityId, decisionAt, params: featureParamsFromCharter(charter) });
  const candidates = selectCandidates({ features: fs, held, params: candidateParamsFromCharter(charter) });

  const vols = new Map<string, Dec>();
  for (const id of candidates.selected) {
    const v = fs.features.get(id)?.vol;
    if (v !== undefined) vols.set(id, v);
  }
  const targets = constructTargets({ selected: candidates.selected, volatilities: vols, covariance: fs.covariance, params: sizingParamsFromCharter(charter) });

  const labels = [...new Set([...fs.labels, ...candidates.labels])].sort();
  return { arm: "B1_DETERMINISTIC", decisionAt, anchorSession: fs.anchorSession, anchorFromData: fs.anchorFromData, targetWeights: sortedByEntity(targets.weights), cashWeight: targets.cashWeight, labels };
}

/**
 * The B0 passive comparator: fully invested in the primary benchmark and held. It makes no signal read and no
 * decision - deliberately the dullest possible comparator (ALPHA_CHARTER.md; runBacktest's B0). Its target is a
 * constant every instant.
 */
export function passiveTargetBook(charter: Charter, deps: DecisionEngineDeps, decisionAt: UtcInstant): ArmTargetBook {
  return {
    arm: "B0_PASSIVE",
    decisionAt,
    anchorSession: deps.calendar.previousSession(decisionAt),
    anchorFromData: true, // no data read at all: the passive constant is not anchored to market observations
    targetWeights: [{ entityId: charter.benchmarks.primary, weight: ONE }],
    cashWeight: ZERO,
    labels: [],
  };
}

/**
 * Both deterministic arms' target books at one instant. This charter declares no LLM arm, so there is no C1/D1
 * here; when a charter does, its overlay arms are added at this seam (and only ever as display metadata - no
 * model output may change a weight, T-05).
 */
export function prospectiveTargetBooks(charter: Charter, deps: DecisionEngineDeps, decisionAt: UtcInstant, held: ReadonlySet<string>): ArmTargetBook[] {
  return [passiveTargetBook(charter, deps, decisionAt), deterministicTargetBook(charter, deps, decisionAt, held)];
}
