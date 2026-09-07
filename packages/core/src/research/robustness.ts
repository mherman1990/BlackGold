import { Dec, ONE, ZERO, hashJson } from "@blackgold/shared";
import type { Charter } from "../strategy/charter.ts";

/**
 * Robustness harness (docs/EXPERIMENT_PROTOCOL.md sections 5.4, 5.7, 5.8; ALPHA_CHARTER.md sections 15, 16).
 *
 * Three jobs, all of them about fragility rather than performance:
 *
 *  - enumerate the charter's frozen sensitivity grid exactly, so the declared trial count N is derived from
 *    the charter and cannot drift from what multiple-testing statistics are computed against;
 *  - enumerate the cost, delay and missing-data tiers the protocol mandates;
 *  - evaluate the charter's own falsifiers against a set of computed metrics and return a verdict.
 *
 * Every falsifier is a predicate over numbers a runner supplies. The harness never computes a return itself,
 * which keeps the pass/fail logic readable next to the charter text it implements and keeps it testable
 * without a backtest.
 */

export const ROBUSTNESS_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Sensitivity grid
// ---------------------------------------------------------------------------------------------

export type GridPoint = {
  momentumLookbackSessions: number;
  momentumSkipSessions: number;
  trendSmaSessions: number;
  volatilitySessions: number;
  entryRank: number;
  holdRank: number;
  annualVolatilityTarget: Dec;
  rebalanceBandPctPoints: Dec;
};

export type GridEnumeration = {
  points: GridPoint[];
  /** The declared trial count N. Equals `points.length` by construction. */
  trialCount: number;
  /** Index of the registered point inside `points`. The charter schema guarantees it is a member. */
  registeredIndex: number;
  gridHash: string;
};

function gridKey(p: GridPoint): string {
  return [
    p.momentumLookbackSessions,
    p.momentumSkipSessions,
    p.trendSmaSessions,
    p.volatilitySessions,
    p.entryRank,
    p.holdRank,
    p.annualVolatilityTarget.toFixed(),
    p.rebalanceBandPctPoints.toFixed(),
  ].join("|");
}

/**
 * The full Cartesian product of the charter's sensitivity grid, in a stable order.
 *
 * Order is the charter's declaration order, so the same charter always yields the same trial ids and a
 * re-run reproduces the trial ledger row for row.
 */
export function enumerateGrid(c: Charter): GridEnumeration {
  const g = c.sensitivity_grid;
  const points: GridPoint[] = [];
  for (const mom of g.momentum) {
    for (const sma of g.trend_sma_sessions) {
      for (const vol of g.volatility_sessions) {
        for (const rank of g.ranks) {
          for (const target of g.annual_volatility_target) {
            for (const band of g.rebalance_band_pct_points) {
              points.push({
                momentumLookbackSessions: mom.lookback_sessions,
                momentumSkipSessions: mom.skip_sessions,
                trendSmaSessions: sma,
                volatilitySessions: vol,
                entryRank: rank.entry,
                holdRank: rank.hold,
                annualVolatilityTarget: new Dec(target),
                rebalanceBandPctPoints: new Dec(band),
              });
            }
          }
        }
      }
    }
  }
  const registered: GridPoint = {
    momentumLookbackSessions: c.features.momentum_lookback_sessions,
    momentumSkipSessions: c.features.momentum_skip_sessions,
    trendSmaSessions: c.features.trend_sma_sessions,
    volatilitySessions: c.features.volatility_sessions,
    entryRank: c.rules.entry_rank,
    holdRank: c.rules.hold_rank,
    annualVolatilityTarget: new Dec(c.sizing.annual_volatility_target),
    rebalanceBandPctPoints: new Dec(c.rules.rebalance_band_pct_points),
  };
  const key = gridKey(registered);
  const registeredIndex = points.findIndex((p) => gridKey(p) === key);
  return {
    points,
    trialCount: points.length,
    registeredIndex,
    gridHash: `sha256:${hashJson(points.map(gridKey))}`,
  };
}

/** Adjacent grid cells: points differing from `index` in exactly one dimension (protocol section 5.4). */
export function adjacentPoints(grid: GridEnumeration, index: number): number[] {
  const target = grid.points[index];
  if (!target) throw new RangeError(`no grid point at index ${index}`);
  const fields = (p: GridPoint): string[] => gridKey(p).split("|");
  const targetFields = fields(target);
  const out: number[] = [];
  grid.points.forEach((p, i) => {
    if (i === index) return;
    const diff = fields(p).reduce((acc, v, j) => acc + (v === targetFields[j] ? 0 : 1), 0);
    if (diff === 1) out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Cost, delay and missing-data tiers
// ---------------------------------------------------------------------------------------------

export type SensitivityTier = {
  id: string;
  kind: "COST" | "DELAY" | "MISSING_DATA";
  costTier: "base" | "adverse" | "stress";
  multiplier: Dec;
  delayBars: number;
  missingDataRate: Dec;
  /** True when the tier is a labelled assumption that can never be promotion evidence. */
  barsPromotionEvidence: boolean;
};

/**
 * The tiers the protocol mandates: base, adverse and stress costs; each declared stress multiplier; each
 * declared delay; each declared missing-data rate. A delay of zero fills at the decision close itself, which
 * is labelled OPTIMISTIC_DELAY and therefore barred from promotion evidence.
 */
export function enumerateTiers(c: Charter): SensitivityTier[] {
  const out: SensitivityTier[] = [];
  const baseDelay = c.costs.base.delay_bars;
  for (const tier of ["base", "adverse", "stress"] as const) {
    out.push({
      id: `cost/${tier}`,
      kind: "COST",
      costTier: tier,
      multiplier: ONE,
      delayBars: c.costs[tier].delay_bars,
      missingDataRate: ZERO,
      barsPromotionEvidence: c.costs[tier].delay_bars === 0,
    });
  }
  for (const m of c.costs.stress_multipliers) {
    const mult = new Dec(m);
    if (mult.eq(ONE)) continue; // 1.0 is the base tier already enumerated
    out.push({ id: `cost/base_x${mult.toFixed()}`, kind: "COST", costTier: "base", multiplier: mult, delayBars: baseDelay, missingDataRate: ZERO, barsPromotionEvidence: false });
  }
  for (const d of c.costs.delay_sensitivity_bars) {
    if (d === baseDelay) continue; // already covered by cost/base
    out.push({ id: `delay/${d}`, kind: "DELAY", costTier: "base", multiplier: ONE, delayBars: d, missingDataRate: ZERO, barsPromotionEvidence: d === 0 });
  }
  for (const r of c.costs.missing_data_rates) {
    const rate = new Dec(r);
    if (rate.isZero()) continue; // zero is the base tier
    out.push({ id: `missing/${rate.toFixed()}`, kind: "MISSING_DATA", costTier: "base", multiplier: ONE, delayBars: baseDelay, missingDataRate: rate, barsPromotionEvidence: true });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Falsifiers
// ---------------------------------------------------------------------------------------------

export type FalsifierMetrics = {
  /** Primary metric point estimate: the after-cost Sharpe difference against the primary benchmark. */
  primaryPointEstimate: number;
  primaryIntervalLower: number;
  primaryIntervalUpper: number;
  /** Strategy and benchmark maximum drawdown as non-positive decimals. */
  strategyMaxDrawdown: Dec;
  benchmarkMaxDrawdown: Dec;
  /** Primary metric under the adverse cost tier and under one extra session of delay. */
  primaryUnderAdverseCosts: number;
  primaryUnderExtraDelay: number;
  /** Primary metric with the single best rolling 12-month window removed. */
  primaryWithoutBestYear: number;
  /** Signs of the primary metric across every evaluated grid member. */
  gridPointEstimates: readonly number[];
  /** Primary metric against the volatility-controlled benchmark: the charter's decisive second bar. */
  primaryVersusVolatilityControlled: number | undefined;
  /** Independent (non-overlapping) out-of-sample decision blocks the result rests on. */
  independentDecisions: number;
};

export type FalsifierOutcome = {
  id: string;
  condition: string;
  /** True when the falsifier fired: the charter's stated failure condition is met. */
  triggered: boolean;
  detail: string;
};

export type RobustnessVerdict = {
  strategyId: string;
  charterVersion: string;
  outcomes: FalsifierOutcome[];
  /** Fraction of grid members agreeing in sign with the registered point. */
  gridSignAgreement: Dec;
  /** True when no falsifier fired AND the minimum independent-decision count is met. */
  passes: boolean;
  /**
   * The charter's decisive falsifier (section 16.1): the hypothesis is rejected only when the strategy
   * beats neither the primary benchmark nor the volatility-controlled variant. A single failure elsewhere
   * sends the charter to owner review; both failures reject it.
   */
  decisiveRejection: boolean;
  failedIds: string[];
  robustnessVersion: number;
  verdictHash: string;
};

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/**
 * Evaluate every falsifier the charter declares.
 *
 * The mapping from falsifier id to predicate is explicit and exhaustive: an id in the charter with no
 * predicate here is reported as `UNEVALUATED` rather than silently passing, so adding a falsifier to the
 * charter cannot quietly weaken the verdict.
 */
export function evaluateFalsifiers(c: Charter, m: FalsifierMetrics): RobustnessVerdict {
  const threshold = Number(c.pass_fail.primary_threshold);
  const ddRatio = new Dec(c.pass_fail.max_drawdown_ratio);
  const minAgreement = new Dec(c.pass_fail.min_grid_sign_agreement);

  const registeredSign = sign(m.primaryPointEstimate);
  const agreeing = m.gridPointEstimates.filter((v) => sign(v) === registeredSign).length;
  const agreement = m.gridPointEstimates.length === 0 ? ZERO : new Dec(agreeing).div(m.gridPointEstimates.length);

  const outcomes: FalsifierOutcome[] = [];
  for (const f of c.pass_fail.falsifiers) {
    switch (f.id) {
      case "F1": {
        const belowThreshold = m.primaryPointEstimate < threshold;
        const includesZero = !((m.primaryIntervalLower > 0 && m.primaryIntervalUpper > 0) || (m.primaryIntervalLower < 0 && m.primaryIntervalUpper < 0));
        outcomes.push({
          id: f.id,
          condition: f.condition,
          triggered: belowThreshold || includesZero,
          detail: `point estimate ${m.primaryPointEstimate.toFixed(4)} against threshold ${threshold}; interval [${m.primaryIntervalLower.toFixed(4)}, ${m.primaryIntervalUpper.toFixed(4)}]${includesZero ? " includes zero" : " excludes zero"}`,
        });
        break;
      }
      case "F2": {
        // Drawdowns are non-positive: the strategy passes when |strategy| <= ratio x |benchmark|.
        const limit = m.benchmarkMaxDrawdown.abs().times(ddRatio);
        const triggered = m.strategyMaxDrawdown.abs().gt(limit);
        outcomes.push({
          id: f.id,
          condition: f.condition,
          triggered,
          detail: `strategy drawdown ${m.strategyMaxDrawdown.toFixed(4)} against the limit ${limit.negated().toFixed(4)} (${ddRatio.toFixed()} of ${m.benchmarkMaxDrawdown.toFixed(4)})`,
        });
        break;
      }
      case "F3": {
        const flips = sign(m.primaryUnderAdverseCosts) !== registeredSign || sign(m.primaryUnderExtraDelay) !== registeredSign;
        outcomes.push({
          id: f.id,
          condition: f.condition,
          triggered: flips,
          detail: `adverse costs ${m.primaryUnderAdverseCosts.toFixed(4)}, extra delay ${m.primaryUnderExtraDelay.toFixed(4)}, registered ${m.primaryPointEstimate.toFixed(4)}`,
        });
        break;
      }
      case "F4": {
        const flips = sign(m.primaryWithoutBestYear) !== registeredSign;
        outcomes.push({ id: f.id, condition: f.condition, triggered: flips, detail: `without the best 12-month window: ${m.primaryWithoutBestYear.toFixed(4)}` });
        break;
      }
      case "F5": {
        outcomes.push({
          id: f.id,
          condition: f.condition,
          triggered: agreement.lt(minAgreement),
          detail: `${agreeing} of ${m.gridPointEstimates.length} grid members agree in sign (${agreement.toFixed(4)}) against the required ${minAgreement.toFixed()}`,
        });
        break;
      }
      case "F6": {
        // Prospective only: it cannot fire on historical evidence, and saying so is more useful than
        // reporting a vacuous pass.
        outcomes.push({ id: f.id, condition: f.condition, triggered: false, detail: "prospective falsifier: not evaluable from historical results" });
        break;
      }
      default:
        outcomes.push({ id: f.id, condition: f.condition, triggered: true, detail: "UNEVALUATED: this falsifier has no predicate in robustness.ts, so it fails closed" });
    }
  }

  const enoughDecisions = m.independentDecisions >= c.pass_fail.minimum_independent_decisions;
  if (!enoughDecisions) {
    outcomes.push({
      id: "MINIMUM_DECISIONS",
      condition: `at least ${c.pass_fail.minimum_independent_decisions} independent out-of-sample decisions`,
      triggered: true,
      detail: `${m.independentDecisions} independent decisions is below the charter's minimum of ${c.pass_fail.minimum_independent_decisions}`,
    });
  }

  const failedIds = outcomes.filter((o) => o.triggered).map((o) => o.id);
  const beatsPrimary = m.primaryPointEstimate >= threshold && !outcomes.some((o) => o.id === "F1" && o.triggered);
  const beatsVolControlled = m.primaryVersusVolatilityControlled !== undefined && m.primaryVersusVolatilityControlled > 0;
  const body = {
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    outcomes: outcomes.map((o) => [o.id, o.triggered]),
    gridSignAgreement: agreement.toFixed(6),
  };

  return {
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    outcomes,
    gridSignAgreement: agreement,
    passes: failedIds.length === 0,
    decisiveRejection: !beatsPrimary && !beatsVolControlled,
    failedIds,
    robustnessVersion: ROBUSTNESS_VERSION,
    verdictHash: `sha256:${hashJson(body)}`,
  };
}
