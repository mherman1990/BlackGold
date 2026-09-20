import { Dec, ONE, hashJson, type IsoDate } from "@blackgold/shared";
import type { Charter } from "../strategy/charter.ts";
import { annualizedSharpe, stationaryBootstrap, type BootstrapResult } from "./stats.ts";
import type { SplitKind } from "./walkforward.ts";

/**
 * ALPHA_CHARTER section 16.1 at the scope the charter defines it: the **aggregate walk-forward
 * out-of-sample set**, splits pooled.
 *
 * Section 13 scopes the primary metric's pass rule ("point estimate at least +0.10 and the bootstrap
 * interval excludes zero **on the aggregate walk-forward out-of-sample set**") and section 16.1 scopes the
 * decisive falsifier the same way. Neither is a per-split statement, and `runEvaluation` deliberately emits
 * no section 16.1 verdict per split: several windows would produce contradictory verdicts where the charter
 * registers exactly one, and the DESIGN window would contribute an in-sample one
 * (`docs/analysis/2026-09-20-d51-primary-metric.md`, sections 2b and 2c).
 *
 * This module is the missing scope. It takes what each walk-forward split computed and returns one verdict.
 * It computes no return itself: every number is supplied by a run, exactly as `evaluateFalsifiers` works,
 * so the pooling rules stay readable next to the charter text they implement.
 *
 * Four rules, all fail-closed, and all of them about not manufacturing a rejection:
 *
 *  - **Only WALK_FORWARD splits.** DESIGN is in-sample (section 14.1), RECENT is quasi-forward and reported
 *    separately, HOLDOUT is sealed. A split of any other kind is a caller defect, not a data condition.
 *  - **The pooled set must be the whole schedule.** A verdict from a subset of windows is window-shopping:
 *    the same charter would reject or not depending on which `--split` the operator passed. An incomplete
 *    pool can reach OWNER_REVIEW or UNMEASURED but never REJECT.
 *  - **Both prongs must be measured.** Section 16.1 rejects "if both fail"; an absent second prong is not a
 *    failed one. One split without a usable Secondary 2 leaves the aggregate prong unmeasured, because a
 *    comparator covering part of the window is not the registered comparator.
 *  - **Returns link, they do not add.** Each split is backtested from cash, so the aggregate is the chained
 *    product of the per-split total returns. Summing them is wrong by more than rounding over eight windows,
 *    and the error does not cancel between the strategy and its comparator.
 *
 * What it does NOT do: decide anything. A REJECT here is a computed reading of a preregistered rule, not an
 * owner decision, and section 16.1's conflict with section 17 is surfaced rather than resolved (CLAUDE.md,
 * "What standing authorization never covers").
 */

export const AGGREGATE_VERSION = 1;

/**
 * Section 16.1's three outcomes.
 *
 *  - `REJECT` - both prongs measured and both failed: "the hypothesis is rejected and the charter is marked
 *    REJECTED with results preserved."
 *  - `OWNER_REVIEW` - both prongs measured and at least one passed: "if either passes, the charter goes to
 *    owner review."
 *  - `UNMEASURED` - the verdict was not computable. Section 16.1 has no such outcome because it assumes both
 *    numbers exist; saying so is the only honest third state.
 */
export type Section161Verdict = "REJECT" | "OWNER_REVIEW" | "UNMEASURED";

/** One walk-forward split's contribution to the pool. Every field comes from that split's own run. */
export type AggregateSplitInput = {
  splitId: string;
  kind: SplitKind;
  /** Sessions the run scored, ascending. The overlap check and the session count both read this. */
  sessions: readonly IsoDate[];
  /**
   * Daily excess of the candidate arm over the primary benchmark on their common sessions - the very series
   * `buildResultReport` feeds the per-split bootstrap, so the aggregate and the per-split diagnostics are
   * the same statistic at two scopes rather than two statistics.
   */
  pairedExcess: readonly { session: IsoDate; value: number }[];
  /** The candidate arm's total return over the split. */
  candidateTotalReturn: Dec;
  /**
   * The REGISTERED Secondary 2's total return over the split, or `undefined` when the comparator was not
   * built, or was built inexactly and therefore withheld. Nothing is ever substituted for it.
   */
  secondary2TotalReturn: Dec | undefined;
  /** Why Secondary 2 was unusable on this split, when it was. */
  secondary2UnusableReason: string | undefined;
  citableAsEvidence: boolean;
  citabilityReasons: readonly string[];
  promotionBlockingCodes: readonly string[];
};

export type AggregatePrimaryMetric = {
  name: string;
  /** Annualized Sharpe difference on the pooled paired-excess series. */
  pointEstimate: number;
  interval: BootstrapResult;
  threshold: number;
  /** Section 13's pass rule: point estimate at or above the threshold AND the interval excludes zero. */
  passes: boolean;
  /** Observations in the pooled series. */
  observations: number;
  /**
   * False, always, and stated rather than implied: section 13 registers "a deflated-Sharpe adjustment for
   * the registered trial count (section 15)", and `deflatedSharpe` (stats.ts) needs the cross-trial Sharpe
   * dispersion of the full 72-member sensitivity grid, which one evaluation run does not produce.
   *
   * The direction matters and is recorded in `evidenceCaveats`: deflation can only lower a Sharpe, so an
   * undeflated prong is EASIER to pass. Omitting it biases section 16.1 toward owner review and away from
   * rejection, which is the safe direction for a falsifier but is not the registered statistic.
   */
  deflatedSharpeApplied: false;
};

export type AggregateSecondary2 = {
  /** Chain-linked total return of the candidate across the pooled windows. */
  candidateTotalReturn: string;
  /** Chain-linked total return of the registered Secondary 2 across the same windows. */
  secondary2TotalReturn: string;
  /** Section 13's registered measure: excess return, candidate minus Secondary 2. */
  excessReturn: string;
  /** Section 16.1's second prong: the strategy beats Secondary 2. */
  beats: boolean;
};

export type AggregateWalkForward = {
  aggregateVersion: number;
  strategyId: string;
  charterVersion: string;
  /** Pooled split ids, in evaluation order. */
  splitIds: string[];
  /** Every walk-forward split the charter's schedule declares, whether or not it was run. */
  plannedSplitIds: string[];
  /** True when every planned walk-forward split is in the pool. */
  complete: boolean;
  /** First and last scored session across the pool. `undefined` when nothing was pooled. */
  window: { start: IsoDate; end: IsoDate } | undefined;
  sessions: number;
  /** Joins between consecutive pooled windows: where a bootstrap block can straddle a restart from cash. */
  splitBoundaries: number;
  /** Non-overlapping monthly-equivalent blocks in the pooled set (section 14.3). */
  independentDecisions: number;
  minimumIndependentDecisions: number;
  minimumIndependentDecisionsMet: boolean;
  /** Section 16.1's first prong. `undefined` when the pooled series was too short to bootstrap. */
  primaryMetric: AggregatePrimaryMetric | undefined;
  /** Section 16.1's second prong. `undefined` when any pooled split lacked a usable Secondary 2. */
  secondary2: AggregateSecondary2 | undefined;
  /** Why the second prong is unmeasured, per split. Empty when it is measured. */
  secondary2UnmeasuredReasons: string[];
  verdict: Section161Verdict;
  /** Why the verdict is what it is, in the charter's own terms. */
  verdictReasons: string[];
  /**
   * Set only in the one case where sections 16.1 and 17 disagree: the primary metric fails and Secondary 2
   * passes. Section 16.1 routes that to owner review; section 17 says "If the metric fails, the charter goes
   * to REJECTED, never to ACTIVE." Surfaced, never resolved here - resolving it is a charter edit.
   */
  charterConflict: string | undefined;
  /** True only when every pooled split is citable AND the pool is the whole schedule. */
  citableAsEvidence: boolean;
  citabilityReasons: string[];
  promotionBlockingCodes: string[];
  /**
   * Known limits of this reading that no data-quality flag captures. Not reasons to discount the numbers -
   * reasons an owner should not read them as more than they are.
   */
  evidenceCaveats: string[];
  aggregateHash: string;
};

export class AggregateScopeError extends Error {
  constructor(detail: string) {
    super(`Aggregate walk-forward scope error: ${detail}`);
    this.name = "AggregateScopeError";
  }
}

/**
 * Open owner readings baked into the registered Secondary 2, carried onto any verdict that rests on it.
 *
 * Both are implementations of a charter silence rather than of a charter instruction, which is the D-32
 * shape: Claude Code implemented a reading, and the owner confirms or overrules it before the number is
 * treated as decisive. Remove an entry when `docs/DECISIONS.md` records the owner's answer to it.
 */
export const SECONDARY_2_OPEN_READINGS: readonly string[] = [
  "Secondary 2 re-scales weekly, at the strategy's own decision instants. Section 11 states the estimator, the target and the cash leg but not the cadence; re-scaling every session is equally literal and gives a different number (docs/analysis/2026-09-20-d51-primary-metric.md, section 2d).",
  "Secondary 2 reinvests a distribution at the ex-date session's close, following the total-return index convention. Reinvesting at the open is defensible and would move the second prong.",
];

/** Chain-link total returns: (1 + r1)(1 + r2)... - 1. Each window is backtested from cash, so they multiply. */
function linkTotalReturns(returns: readonly Dec[]): Dec {
  let growth = ONE;
  for (const r of returns) growth = growth.times(ONE.plus(r));
  return growth.minus(ONE);
}

const SESSIONS_PER_MONTH = 21;

export type AggregateInput = {
  charter: Charter;
  /** The walk-forward splits that ran, in any order. */
  splits: readonly AggregateSplitInput[];
  /** Every walk-forward split id in the charter's schedule, from `splitPlan`. */
  plannedSplitIds: readonly string[];
  bootstrapResamples?: number;
  bootstrapSeed?: number;
};

/**
 * Pool the walk-forward splits and evaluate section 16.1 once over the result.
 *
 * Throws `AggregateScopeError` for the two conditions that mean the caller, not the data, is wrong: a split
 * that is not a walk-forward split, and two pooled splits scoring the same session. `splitPlan` already
 * guarantees the schedule tiles without overlap, so an overlap here is a scheduler defect; returning an
 * `undefined` verdict for it would hide a bug behind a legitimate-looking "not measured".
 */
export function aggregateWalkForward(input: AggregateInput): AggregateWalkForward {
  const c = input.charter;

  for (const s of input.splits) {
    if (s.kind !== "WALK_FORWARD") {
      throw new AggregateScopeError(
        `split ${s.splitId} is ${s.kind}; section 16.1 is defined on the walk-forward out-of-sample set only`,
      );
    }
    if (!input.plannedSplitIds.includes(s.splitId)) {
      throw new AggregateScopeError(`split ${s.splitId} is not in the charter's walk-forward schedule`);
    }
  }

  // Evaluation order, so the pooled series is a time series rather than whatever order the runner produced.
  // The block bootstrap draws contiguous runs, so this is not cosmetic: a shuffled pool would preserve the
  // point estimate and change the interval.
  const ordered = [...input.splits].sort((a, b) => {
    const ka = a.sessions[0] ?? a.splitId;
    const kb = b.sessions[0] ?? b.splitId;
    return ka < kb ? -1 : ka > kb ? 1 : a.splitId < b.splitId ? -1 : a.splitId > b.splitId ? 1 : 0;
  });

  const seen = new Map<IsoDate, string>();
  for (const s of ordered) {
    for (const session of s.sessions) {
      const owner = seen.get(session);
      if (owner !== undefined) {
        throw new AggregateScopeError(`splits ${owner} and ${s.splitId} both score ${session}; the pool would double-count it`);
      }
      seen.set(session, s.splitId);
    }
  }

  const pooledSessions = [...seen.keys()].sort();
  const pooledExcess: number[] = [];
  for (const s of ordered) for (const p of s.pairedExcess) pooledExcess.push(p.value);

  const splitIds = ordered.map((s) => s.splitId);
  const plannedSplitIds = [...input.plannedSplitIds];
  const missing = plannedSplitIds.filter((id) => !splitIds.includes(id));
  const complete = missing.length === 0 && plannedSplitIds.length > 0;

  const first = pooledSessions[0];
  const last = pooledSessions[pooledSessions.length - 1];
  const window = first === undefined || last === undefined ? undefined : { start: first, end: last };
  const independentDecisions = Math.floor(pooledSessions.length / SESSIONS_PER_MONTH);
  const minimumIndependentDecisions = c.pass_fail.minimum_independent_decisions;
  const minimumMet = independentDecisions >= minimumIndependentDecisions;

  // ---- First prong: the primary metric on the pooled paired-excess series -------------------------
  const threshold = Number(c.pass_fail.primary_threshold);
  let primaryMetric: AggregatePrimaryMetric | undefined;
  if (pooledExcess.length >= 2) {
    const interval = stationaryBootstrap(pooledExcess, annualizedSharpe, {
      meanBlockSessions: c.pass_fail.bootstrap_block_sessions,
      confidence: Number(c.pass_fail.bootstrap_confidence),
      ...(input.bootstrapResamples === undefined ? {} : { resamples: input.bootstrapResamples }),
      ...(input.bootstrapSeed === undefined ? {} : { seed: input.bootstrapSeed }),
    });
    primaryMetric = {
      name: c.pass_fail.primary_metric,
      pointEstimate: interval.pointEstimate,
      interval,
      threshold,
      passes: interval.pointEstimate >= threshold && interval.excludesZero,
      observations: pooledExcess.length,
      deflatedSharpeApplied: false,
    };
  }

  // ---- Second prong: excess return over the registered Secondary 2 --------------------------------
  // Collected, not defaulted. A `?? ZERO` here would turn a split with no comparator into a split whose
  // comparator returned nothing - a flat leg the strategy would beat for free - which is exactly the
  // substitution the whole Secondary 2 work exists to prevent.
  const secondary2UnmeasuredReasons: string[] = [];
  const secondary2Returns: Dec[] = [];
  for (const s of ordered) {
    if (s.secondary2TotalReturn === undefined) {
      secondary2UnmeasuredReasons.push(
        `${s.splitId}: ${s.secondary2UnusableReason ?? "the registered Secondary 2 was not available for this split"}`,
      );
    } else {
      secondary2Returns.push(s.secondary2TotalReturn);
    }
  }
  if (ordered.length === 0) secondary2UnmeasuredReasons.push("no walk-forward split was pooled");

  let secondary2: AggregateSecondary2 | undefined;
  if (secondary2UnmeasuredReasons.length === 0) {
    const candidateTotalReturn = linkTotalReturns(ordered.map((s) => s.candidateTotalReturn));
    const secondary2TotalReturn = linkTotalReturns(secondary2Returns);
    const excessReturn = candidateTotalReturn.minus(secondary2TotalReturn);
    secondary2 = {
      candidateTotalReturn: candidateTotalReturn.toFixed(8),
      secondary2TotalReturn: secondary2TotalReturn.toFixed(8),
      excessReturn: excessReturn.toFixed(8),
      beats: excessReturn.gt(0),
    };
  }

  // ---- Section 16.1 -------------------------------------------------------------------------------
  //
  // Completeness is checked FIRST, before either prong is read. Section 16.1 is a statement about "the
  // aggregate walk-forward out-of-sample set", and a pool missing windows is a different set: the same
  // charter would reach a different verdict depending on which `--split` the operator passed. Both outcomes
  // are withheld from a partial pool, not just the rejection, because "goes to owner review" is equally a
  // claim about a set that was not measured. The prong numbers are still reported - they are what the run
  // computed - and `verdictReasons` says what they showed.
  const verdictReasons: string[] = [];
  let verdict: Section161Verdict;
  let charterConflict: string | undefined;

  if (!complete) {
    verdict = "UNMEASURED";
    verdictReasons.push(
      plannedSplitIds.length === 0
        ? "the charter's walk-forward schedule declares no splits, so there is no aggregate out-of-sample set to evaluate"
        : `${splitIds.length} of the schedule's ${plannedSplitIds.length} walk-forward split(s) were pooled; ${missing.length} absent (${missing.join(", ")}). Section 16.1 is defined on the aggregate set, and a verdict from part of it would be decided by which windows were run.`,
    );
  } else if (primaryMetric === undefined || secondary2 === undefined) {
    verdict = "UNMEASURED";
    if (primaryMetric === undefined) {
      verdictReasons.push(
        `the pooled paired-excess series holds ${pooledExcess.length} observation(s); a bootstrap interval needs at least two, and section 13 admits no point estimate without one`,
      );
    }
    if (secondary2 === undefined) {
      verdictReasons.push('the second prong is unmeasured, and section 16.1 rejects only "if both fail": absence is not failure');
    }
  } else if (primaryMetric.passes || secondary2.beats) {
    verdict = "OWNER_REVIEW";
    verdictReasons.push(
      primaryMetric.passes && secondary2.beats
        ? "both prongs passed"
        : primaryMetric.passes
          ? "the primary metric passed on the aggregate walk-forward out-of-sample set, and the strategy did not beat Secondary 2"
          : "the strategy beat Secondary 2 while the primary metric failed",
    );
    verdictReasons.push('section 16.1: "If either passes, the charter goes to owner review."');
    if (!primaryMetric.passes && secondary2.beats) {
      charterConflict =
        'Sections 16.1 and 17 disagree about this exact case. Section 16.1: "If either passes, the charter goes to owner review." Section 17: "If the metric fails, the charter goes to REJECTED, never to ACTIVE." The primary metric failed and Secondary 2 passed, so the two rules route the charter to different states. Which one governs is a charter question and therefore the owner\'s; it is not resolved here.';
      verdictReasons.push("this is the case sections 16.1 and 17 disagree on; see `charterConflict`");
    }
  } else {
    verdict = "REJECT";
    verdictReasons.push(
      "the strategy failed to improve the primary metric over the primary benchmark on the aggregate walk-forward out-of-sample set AND failed to beat Secondary 2",
    );
    verdictReasons.push('section 16.1: "if both fail, the hypothesis is rejected and the charter is marked REJECTED with results preserved."');
  }

  // ---- Citability and caveats ---------------------------------------------------------------------
  const citabilityReasons: string[] = [];
  const promotionBlocking = new Set<string>();
  for (const s of ordered) {
    for (const code of s.promotionBlockingCodes) promotionBlocking.add(code);
    if (!s.citableAsEvidence) {
      for (const reason of s.citabilityReasons) citabilityReasons.push(`${s.splitId}: ${reason}`);
      if (s.citabilityReasons.length === 0) citabilityReasons.push(`${s.splitId}: not citable as promotion evidence`);
    }
  }
  if (!complete) {
    citabilityReasons.push(
      plannedSplitIds.length === 0
        ? "the charter's walk-forward schedule is empty, so there is no aggregate set to pool"
        : `the pool is missing ${missing.length} of the schedule's ${plannedSplitIds.length} walk-forward split(s)`,
    );
  }

  const evidenceCaveats: string[] = [];
  if (primaryMetric !== undefined) {
    evidenceCaveats.push(
      "The deflated-Sharpe adjustment section 13 registers for the trial count is NOT applied: it needs the cross-trial Sharpe dispersion of the full sensitivity grid, which one evaluation run does not produce. Deflation can only lower a Sharpe, so the prong here is easier to pass than the registered statistic - the omission biases section 16.1 toward owner review and away from rejection.",
    );
  }
  if (ordered.length > 1) {
    evidenceCaveats.push(
      `Each window is backtested from cash, so at each of the ${ordered.length - 1} boundaries the strategy sits flat until its first fill while the benchmark is fully invested - a paired-excess drag, and a round of re-entry cost, that a continuously-held portfolio would not pay. Bootstrap blocks drawn from the concatenated series can also straddle a boundary.`,
    );
  }
  if (!minimumMet) {
    evidenceCaveats.push(
      `The pooled set holds ${independentDecisions} monthly-equivalent independent blocks against the charter's minimum of ${minimumIndependentDecisions} (section 14.3). Section 16.1 states no such precondition, so the verdict above is computed anyway - but the registered walk-forward schedule cannot on its own reach the count the charter calls a minimum useful number.`,
    );
  }
  if (secondary2 !== undefined) for (const reading of SECONDARY_2_OPEN_READINGS) evidenceCaveats.push(reading);

  const body = {
    aggregateVersion: AGGREGATE_VERSION,
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    splitIds,
    complete,
    sessions: pooledSessions.length,
    primary: primaryMetric === undefined ? "unmeasured" : [primaryMetric.pointEstimate, primaryMetric.interval.lower, primaryMetric.interval.upper, primaryMetric.passes],
    secondary2: secondary2 === undefined ? "unmeasured" : [secondary2.excessReturn, secondary2.beats],
    verdict,
  };

  return {
    aggregateVersion: AGGREGATE_VERSION,
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    splitIds,
    plannedSplitIds,
    complete,
    window,
    sessions: pooledSessions.length,
    splitBoundaries: Math.max(ordered.length - 1, 0),
    independentDecisions,
    minimumIndependentDecisions,
    minimumIndependentDecisionsMet: minimumMet,
    primaryMetric,
    secondary2,
    secondary2UnmeasuredReasons,
    verdict,
    verdictReasons,
    charterConflict,
    citableAsEvidence: citabilityReasons.length === 0 && ordered.length > 0,
    citabilityReasons,
    promotionBlockingCodes: [...promotionBlocking].sort(),
    evidenceCaveats,
    aggregateHash: `sha256:${hashJson(body)}`,
  };
}
