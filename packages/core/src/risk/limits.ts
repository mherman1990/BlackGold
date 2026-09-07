import { Dec, ZERO, sumDec } from "@blackgold/shared";
import type { RiskConfig } from "../config/schema.ts";
import { admittedRiskEtfs, type Charter } from "../strategy/charter.ts";
import { classifyCandidateFactors } from "../strategy/factors.ts";

/**
 * The deterministic risk-limit guard (docs/PRODUCT_SPEC.md sections 8: the `RiskEngine` verdict).
 *
 * This is an INDEPENDENT re-check of a proposed target book against the caps in `risk.yaml` and the charter,
 * separate from construction (`strategy/construct.ts`) - the spec keeps candidate score, portfolio target, and
 * risk verdict as distinct objects, and an equivalent guard runs again in the broker gateway. It admits or
 * rejects and names every breach with a reason code; it never re-sizes (that is construction's job). Pure: it
 * reads only weights, the policy, and the frozen charter - no model, broker, or network (T-05; the engine
 * lives under `risk/`, which the analyst layer is forbidden to import).
 *
 * Fail closed: a holding the charter does not classify has an unknown sector, so its concentration cannot be
 * checked - it is rejected, not waved through (spec section 11, "unknown classification blocks new risk").
 *
 * Scope of this first limit engine: admission (a held instrument must be an admitted risk ETF of the charter -
 * being classified is not the same as being admitted, so an unadmitted conditional member like XLE is
 * rejected), per-instrument weight, open-position count (the stricter of the risk.yaml and charter caps),
 * gross/net exposure, the cash floor, sector concentration, and correlated-cluster weight and membership.
 * Factor concentration (the broad
 * `market` tag is on every holding and needs a policy decision on which tags are cap-bearing), theme and
 * liquidity limits, order-level notional/quantity/turnover, and the per-position initial-risk budget are
 * deferred to follow-up limit engines that need order, price, or theme data this check does not take.
 */

export type LimitViolation = { code: string; detail: string };
export type RiskVerdict = { admitted: boolean; violations: LimitViolation[] };

export type RiskLimitsInput = {
  policy: RiskConfig;
  charter: Charter;
  /** Target risk-ETF weights as fractions of NAV, keyed by entity id. Long-only, so each should be >= 0. */
  weights: ReadonlyMap<string, Dec>;
  /** Cash leg weight, `1 - sum(weights)`. */
  cashWeight: Dec;
};

/** Held lines: weight strictly greater than zero. */
function held(weights: ReadonlyMap<string, Dec>): [string, Dec][] {
  return [...weights].filter(([, w]) => w.gt(0)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export function evaluateRiskLimits(input: RiskLimitsInput): RiskVerdict {
  const v: LimitViolation[] = [];
  const p = input.policy;
  const lines = held(input.weights);

  // Long-only: a negative target weight is a posture breach, not a small one.
  for (const [id, w] of [...input.weights].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (w.isNegative()) v.push({ code: "NEGATIVE_WEIGHT", detail: `${id} target weight ${w.toFixed()} is negative; the book is long-only` });
  }

  // Per-instrument weight cap (every universe member here is an ETF).
  const etfCap = new Dec(p.positionLimits.maxSingleEtfWeightPct);
  for (const [id, w] of lines) {
    if (w.gt(etfCap)) v.push({ code: "SINGLE_ETF_WEIGHT", detail: `${id} weight ${w.toFixed(4)} exceeds maxSingleEtfWeightPct ${p.positionLimits.maxSingleEtfWeightPct}` });
  }

  // Open-position count: the stricter of the sleeve-wide risk.yaml cap and the frozen charter's book size.
  const maxPositions = Math.min(p.positionLimits.maxOpenPositions, input.charter.rules.max_positions);
  if (lines.length > maxPositions) {
    v.push({ code: "MAX_OPEN_POSITIONS", detail: `${lines.length} open positions exceed the binding cap ${maxPositions} (risk.yaml ${p.positionLimits.maxOpenPositions}, charter ${input.charter.rules.max_positions})` });
  }

  // Gross and net exposure (long-only: net equals gross), and the cash floor.
  const gross = sumDec(lines.map(([, w]) => w));
  if (gross.gt(new Dec(p.exposure.maxGrossExposurePct))) v.push({ code: "GROSS_EXPOSURE", detail: `gross ${gross.toFixed(4)} exceeds maxGrossExposurePct ${p.exposure.maxGrossExposurePct}` });
  if (gross.gt(new Dec(p.exposure.maxNetExposurePct))) v.push({ code: "NET_EXPOSURE", detail: `net ${gross.toFixed(4)} exceeds maxNetExposurePct ${p.exposure.maxNetExposurePct}` });
  if (input.cashWeight.lt(new Dec(p.exposure.minCashPct))) v.push({ code: "MIN_CASH", detail: `cash ${input.cashWeight.toFixed(4)} is below minCashPct ${p.exposure.minCashPct}` });

  // Admission, then sector concentration, then the fail-closed check on any unclassified holding.
  // Being classified in the charter's factor block does NOT mean a holding is admitted: XLE is classified but
  // its conditional universe entry is not admitted, so it must still be rejected here.
  const admitted = new Set(admittedRiskEtfs(input.charter));
  const sectorWeight = new Map<string, Dec>();
  for (const [id, w] of lines) {
    if (!admitted.has(id)) {
      v.push({ code: "NOT_ADMITTED", detail: `${id} is not an admitted risk ETF of this charter (a non-member, or a conditional member that is not admitted)` });
      continue;
    }
    const c = classifyCandidateFactors(input.charter, id);
    if (!c.classified) {
      v.push({ code: "UNCLASSIFIED_HOLDING", detail: `${id} has no factor classification; its concentration cannot be checked (fail closed)` });
      continue;
    }
    for (const tag of c.factors) {
      if (tag.startsWith("sector_")) sectorWeight.set(tag, (sectorWeight.get(tag) ?? ZERO).plus(w));
    }
  }
  const sectorCap = new Dec(p.concentration.maxSectorWeightPct);
  for (const [sector, w] of [...sectorWeight].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (w.gt(sectorCap)) v.push({ code: "SECTOR_CONCENTRATION", detail: `${sector} weight ${w.toFixed(4)} exceeds maxSectorWeightPct ${p.concentration.maxSectorWeightPct}` });
  }

  // Correlated-cluster weight and membership (charter clusters).
  const clusterCap = new Dec(p.concentration.maxCorrelatedClusterWeightPct);
  for (const cl of input.charter.sizing.clusters) {
    const members = cl.members.filter((m) => input.weights.get(m)?.gt(0));
    const clusterWeight = sumDec(members.map((m) => input.weights.get(m) ?? ZERO));
    if (clusterWeight.gt(clusterCap)) {
      v.push({ code: "CLUSTER_WEIGHT", detail: `cluster ${cl.id} weight ${clusterWeight.toFixed(4)} exceeds maxCorrelatedClusterWeightPct ${p.concentration.maxCorrelatedClusterWeightPct}` });
    }
    if (members.length > cl.max_members) {
      v.push({ code: "CLUSTER_MEMBERS", detail: `cluster ${cl.id} holds ${members.length} members, above its max_members ${cl.max_members}` });
    }
  }

  return { admitted: v.length === 0, violations: v };
}

/** A book that is empty (all cash) admits trivially. Exposed so callers can express the base case explicitly. */
export const ALL_CASH_VERDICT: RiskVerdict = { admitted: true, violations: [] };
