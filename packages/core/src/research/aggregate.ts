import { Dec, ONE, ZERO, hashJson, type IsoDate } from "@blackgold/shared";
import type { TRPoint } from "../market/series.ts";
import type { Charter } from "../strategy/charter.ts";
import { maxDrawdown } from "./benchmarks.ts";
import { annualizedSharpeDifference, stationaryBootstrapPaired, type BootstrapResult } from "./stats.ts";
import type { SharpeInputPoint } from "./report.ts";
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
 * It also reads F2 at the same scope, because charter 0.3.0 makes F2 a co-gate on section 17's REGISTERED ->
 * ACTIVE transition (`pass_fail.promotion_co_gates`, D-56), and reports which of section 17's quantitative
 * conditions the pooled set meets. The owner's written acceptance is the other condition, and it is never
 * computed.
 *
 * What it does NOT do: decide anything. A REJECT here is a computed reading of a preregistered rule, not an
 * owner decision. Where sections 16.1 and 17 disagree, the conflict is surfaced unless the charter itself
 * resolves it (`pass_fail.mixed_verdict`); this module never picks a side (CLAUDE.md, "What standing
 * authorization never covers").
 */

/** 2: aggregate F2, section 17's conditions, charter-declared mixed-verdict routing and Secondary 2 readings. */
export const AGGREGATE_VERSION = 2;

/** One point of a total-return level series. F2's chain-link reads nothing else. */
export type IndexLevel = Pick<TRPoint, "session" | "trIndex">;

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
   * The candidate's and the primary benchmark's daily excess returns over cash - the very series
   * `buildResultReport` feeds the per-split bootstrap, so the aggregate and the per-split diagnostic are
   * the same statistic at two scopes rather than two statistics.
   */
  sharpeInputs: readonly SharpeInputPoint[];
  /** The candidate arm's total return over the split. */
  candidateTotalReturn: Dec;
  /**
   * The REGISTERED Secondary 2's total return over the split, or `undefined` when the comparator was not
   * built, or was built inexactly and therefore withheld. Nothing is ever substituted for it.
   */
  secondary2TotalReturn: Dec | undefined;
  /** Why Secondary 2 was unusable on this split, when it was. */
  secondary2UnusableReason: string | undefined;
  /**
   * The candidate arm's and the primary benchmark's total-return levels over the split: the very series the
   * per-split F2 (`drawdownCheck` in evaluate.ts) takes its maximum drawdowns from, so the aggregate F2 is the
   * same statistic at a wider scope.
   */
  candidateIndex: readonly IndexLevel[];
  primaryIndex: readonly IndexLevel[];
  /**
   * Sessions in the split where the primary benchmark's OWN bar was absent or carried forward
   * (`reportBenchmarkSeries`). `navDistortingSessions` cannot carry these: it covers only what the candidate
   * held, and the benchmark is a curve in its own right in F2. A missing or stale benchmark mark can only make
   * its drawdown shallower, which makes F2 harder to clear - a co-gate failure the data did not earn.
   */
  primaryDistortingSessions: readonly IsoDate[];
  /**
   * Sessions where a HELD instrument's bar was absent or carried forward in this split's run
   * (`BacktestResult.navDistortingSessions`). Not the same thing as `promotionBlockingCodes`: a run carrying
   * these is still citable, which is exactly why the first prong has to notice them itself.
   */
  navDistortingSessions: readonly IsoDate[];
  citableAsEvidence: boolean;
  citabilityReasons: readonly string[];
  promotionBlockingCodes: readonly string[];
};

export type AggregatePrimaryMetric = {
  name: string;
  /**
   * The pooled point estimate: annualized Sharpe of the strategy minus annualized Sharpe of the primary
   * benchmark, both in excess of cash. NOT the Sharpe of their difference, which is the information ratio.
   */
  pointEstimate: number;
  interval: BootstrapResult;
  threshold: number;
  /**
   * Section 13's threshold test as the code can compute it today: point estimate at or above the threshold
   * AND the interval excludes zero. It is only PART of the registered pass rule - see `passes`.
   */
  clearsUndeflatedThreshold: boolean;
  /**
   * Section 16.1's first prong. **Tri-state, and `undefined` is not a failure.**
   *
   *  - `false` - the threshold test above failed. Sound without the deflated-Sharpe adjustment, because
   *    that adjustment can only ever add a hurdle: section 15 computes the deflated Sharpe against the
   *    expected maximum over N = 72 trials, and neither reading of how it enters the pass rule (an extra
   *    test, or a deflated estimate substituted into the threshold) can turn a failure into a pass. So a
   *    failing prong stays failing once the grid statistics exist, and section 16.1 may act on it.
   *  - `undefined` - the threshold test passed, but section 13's registered metric also carries "a
   *    deflated-Sharpe adjustment for the registered trial count (section 15)", which is NOT applied
   *    (`deflatedSharpeApplied`). An undeflated pass is not a registered pass: the adjustment could flip it.
   *    Recording that only in `evidenceCaveats` would leave a consumer acting on a concrete verdict that the
   *    missing adjustment might reverse, so the prong is withheld instead, exactly as an inexact Secondary 2
   *    is withheld rather than published with a warning.
   *  - `true` - unreachable until the adjustment is wired. Kept in the type so that wiring it is a change
   *    here and not a new shape.
   */
  passes: boolean | undefined;
  /** Why `passes` is `undefined`, when it is. Empty when the prong was decided. */
  withheldBecause: string[];
  /** Observations in the pooled series. */
  observations: number;
  /**
   * False, always, and stated rather than implied. `deflatedSharpe` (stats.ts) needs the cross-trial Sharpe
   * dispersion of the full 72-member sensitivity grid (section 15: "N = 72 trials and the observed
   * cross-trial variance"), which one evaluation run does not produce. Wiring it is F5's grid sweep.
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

/**
 * F2 on the aggregate walk-forward out-of-sample set: "maximum drawdown not at or below max_drawdown_ratio
 * times the primary benchmark's maximum drawdown".
 *
 * Each window is backtested from its own start, so "the" maximum drawdown across nine windows has to be
 * defined. Charter 0.3.0 defines it on the **chain-linked curve** (owner's choice, D-56): each split's levels
 * rescaled to start where the previous split ended, for the candidate and for the primary benchmark alike.
 * That is the construction the second prong already uses for total returns, and unlike a worst-single-window
 * reading it catches a drawdown that runs across a split boundary.
 */
export type AggregateDrawdown = {
  /** Maximum drawdown of the candidate's chain-linked curve, non-positive. */
  candidateMaxDrawdown: string;
  /** Maximum drawdown of the primary benchmark's chain-linked curve, non-positive. */
  primaryMaxDrawdown: string;
  /** |candidate| / |primary|. `undefined` when the primary never drew down. */
  ratio: string | undefined;
  limitRatio: string;
  /**
   * F2 clears: |candidate| <= `max_drawdown_ratio` x |primary|, the per-split rule at the aggregate scope.
   *
   * Tri-state, and withheld in BOTH directions on a data gap. A carried-forward mark on a held instrument
   * distorts the candidate's levels by an amount and sign that depend on where the gap falls, which is the
   * owner's gap rule (D-51) for both section 16.1 prongs; a drawdown read off the same NAV is no sounder.
   */
  clears: boolean | undefined;
  /** Why `clears` is `undefined`, when it is. */
  withheldBecause: string[];
};

/**
 * Section 17's REGISTERED -> ACTIVE conditions that a computation can speak to: the primary metric passed,
 * and every co-gate the charter registers clears. Owner acceptance in writing is the remaining condition and
 * is deliberately absent - no field here can stand in for it.
 */
export type AggregatePromotionConditions = {
  primaryMetricPasses: boolean | undefined;
  coGates: { id: string; clears: boolean | undefined }[];
  /**
   * Three-valued conjunction over a COMPLETE pool: `false` when any condition is known to fail, `true` only
   * when every one is known to pass, `undefined` otherwise. A partial pool gives `undefined` both ways, for
   * the reason a partial pool gets no section 16.1 verdict.
   */
  met: boolean | undefined;
  reasons: string[];
};

export type AggregateWalkForward = {
  aggregateVersion: number;
  strategyId: string;
  charterVersion: string;
  /**
   * The hash of the exact charter this verdict was computed under, as `runBacktest` and `buildResultReport`
   * both carry. `charter_version` alone does not identify a charter: its contents can change without the
   * version moving, which is routine while a version is being drafted. See the hashed body below.
   */
  charterHash: string;
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
  /** F2 at the aggregate scope. `undefined` when nothing was pooled. */
  drawdown: AggregateDrawdown | undefined;
  /** Section 17's computable REGISTERED -> ACTIVE conditions. */
  promotion: AggregatePromotionConditions;
  /** Why the second prong is unmeasured, per split. Empty when it is measured. */
  secondary2UnmeasuredReasons: string[];
  verdict: Section161Verdict;
  /** Why the verdict is what it is, in the charter's own terms. */
  verdictReasons: string[];
  /**
   * Set only in the one case where sections 16.1 and 17 disagree: the primary metric fails and Secondary 2
   * passes. Section 16.1 routes that to owner review; section 17 says "If the metric fails, the charter goes
   * to REJECTED, never to ACTIVE." Surfaced, never resolved here - resolving it is a charter edit, and a
   * charter that makes it (`pass_fail.mixed_verdict`, 0.3.0) gets no conflict.
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
 * treated as decisive. The owner confirmed both on 2026-10-05 (D-56), and a charter that declares them
 * (`benchmarks.secondary_2_readings`, 0.3.0) no longer carries these caveats. A charter that does not - 0.2.0
 * - still does, because the confirmation is part of the version that records it.
 *
 * The second entry said the opposite of the code until 2026-10-05: it described close reinvestment, the
 * index's convention, as what Secondary 2 does, when `legSplit` (benchmarks.ts) credits a rebalance-session
 * distribution to the pre-open holder as cash and reallocates it at the open. Corrected rather than left,
 * because this text rides on every verdict as a description of the comparator.
 */
export const SECONDARY_2_OPEN_READINGS: readonly string[] = [
  "Secondary 2 re-scales weekly, at the strategy's own decision instants. Section 11 states the estimator, the target and the cash leg but not the cadence; re-scaling every session is equally literal and gives a different number (docs/analysis/2026-09-20-d51-primary-metric.md, section 2d).",
  "On a session that is both an ex-date and a Secondary 2 rebalance, the distribution is credited to the pre-open holder as cash and reallocated at the open, with the rebalance. Section 11 is silent; the total-return index's close-reinvestment convention is the alternative and would move the second prong on exactly those sessions.",
];

/**
 * One continuous level series from per-split ones: each split's levels rescaled to start where the previous
 * split's curve ended. Only each split's growth relative to its own first level carries over, because every
 * window is backtested from its own start. The move from one split's last session to the next split's first
 * belongs to neither window and is not invented here - the convention `linkTotalReturns` follows, since it
 * links each window's first-to-last total return.
 *
 * `undefined` when a split's series does not start at a positive level, which no total-return index does.
 */
function chainLinkLevels(perSplit: readonly (readonly IndexLevel[])[]): { trIndex: Dec }[] | undefined {
  const out: { trIndex: Dec }[] = [];
  let carry = ONE;
  for (const levels of perSplit) {
    const base = levels[0]?.trIndex;
    if (base === undefined) continue;
    if (!base.gt(0)) return undefined;
    const scale = carry.div(base);
    for (const p of levels) out.push({ trIndex: p.trIndex.times(scale) });
    const last = out[out.length - 1];
    if (last !== undefined) carry = last.trIndex;
  }
  return out;
}

/** Chain-link total returns: (1 + r1)(1 + r2)... - 1. Each window is backtested from cash, so they multiply. */
function linkTotalReturns(returns: readonly Dec[]): Dec {
  let growth = ONE;
  for (const r of returns) growth = growth.times(ONE.plus(r));
  return growth.minus(ONE);
}

const SESSIONS_PER_MONTH = 21;

export type AggregateInput = {
  charter: Charter;
  /** From `runEvaluation`'s own input; bound into the verdict's identity. */
  charterHash: string;
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

  for (const split of input.splits) {
    if (split.kind !== "WALK_FORWARD") {
      throw new AggregateScopeError(
        `split ${split.splitId} is ${split.kind}; section 16.1 is defined on the walk-forward out-of-sample set only`,
      );
    }
    if (!input.plannedSplitIds.includes(split.splitId)) {
      throw new AggregateScopeError(`split ${split.splitId} is not in the charter's walk-forward schedule`);
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
  for (const split of ordered) {
    for (const session of split.sessions) {
      const owner = seen.get(session);
      if (owner !== undefined) {
        throw new AggregateScopeError(`splits ${owner} and ${split.splitId} both score ${session}; the pool would double-count it`);
      }
      seen.set(session, split.splitId);
    }
  }

  const pooledSessions = [...seen.keys()].sort();
  const pooledStrategy: number[] = [];
  const pooledBenchmark: number[] = [];
  for (const split of ordered) {
    for (const p of split.sharpeInputs) {
      pooledStrategy.push(p.strategy);
      pooledBenchmark.push(p.benchmark);
    }
  }

  const splitIds = ordered.map((split) => split.splitId);
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
  if (pooledStrategy.length >= 2) {
    const interval = stationaryBootstrapPaired(pooledStrategy, pooledBenchmark, annualizedSharpeDifference, {
      meanBlockSessions: c.pass_fail.bootstrap_block_sessions,
      confidence: Number(c.pass_fail.bootstrap_confidence),
      ...(input.bootstrapResamples === undefined ? {} : { resamples: input.bootstrapResamples }),
      ...(input.bootstrapSeed === undefined ? {} : { seed: input.bootstrapSeed }),
    });
    const clearsUndeflatedThreshold = interval.pointEstimate >= threshold && interval.excludesZero;

    // A gap withholds the prong in BOTH directions, unlike the missing deflation.
    //
    // The deflated-Sharpe adjustment can only ever add a hurdle, so a failure survives it and only a pass is
    // withheld. A data gap is different in kind: it distorts the statistic with a sign that depends on where
    // the gap falls, so it can push the estimate either way. A failing threshold test is then no more
    // trustworthy than a passing one, and withholding only the pass would quietly keep REJECT reachable on
    // a number nobody can vouch for - a rejection being the outcome that is hardest to walk back.
    const gapped = ordered.filter((split) => split.navDistortingSessions.length > 0);
    const withheldBecause: string[] = [];
    if (gapped.length > 0) {
      const sessions = gapped.reduce((n, split) => n + split.navDistortingSessions.length, 0);
      withheldBecause.push(
        `${gapped.length} of ${ordered.length} pooled split(s) hold an instrument whose bar was absent or carried forward on ${sessions} session(s), leaving its multi-day move inside a single daily return. The distortion's sign depends on where the gap falls, so neither a pass nor a failure can be relied on: ${gapped.map((split) => split.splitId).join(", ")}.`,
      );
    }
    if (clearsUndeflatedThreshold) {
      withheldBecause.push(
        'the threshold test clears, but section 13\'s registered "deflated-Sharpe adjustment for the registered trial count" is not applied, and that adjustment can only take a pass away',
      );
    }
    primaryMetric = {
      name: c.pass_fail.primary_metric,
      pointEstimate: interval.pointEstimate,
      interval,
      threshold,
      clearsUndeflatedThreshold,
      passes: withheldBecause.length > 0 ? undefined : false,
      withheldBecause,
      observations: pooledStrategy.length,
      deflatedSharpeApplied: false,
    };
  }

  // ---- Second prong: excess return over the registered Secondary 2 --------------------------------
  // Collected, not defaulted. A `?? ZERO` here would turn a split with no comparator into a split whose
  // comparator returned nothing - a flat leg the strategy would beat for free - which is exactly the
  // substitution the whole Secondary 2 work exists to prevent.
  //
  // The loop variable is spelled out rather than abbreviated to a single letter, and must stay that way.
  // gitleaks' `vault-service-token` rule matches the legacy Vault shape - one letter, a dot, then exactly
  // 24 alphanumerics before whitespace - and the field read just below is exactly 24 characters long, so a
  // one-letter receiver here spells a credential to the scanner and fails CI. (Writing the offending pair
  // out in this comment would trip it just as readily; an earlier version of this note did.)
  const secondary2UnmeasuredReasons: string[] = [];
  const secondary2Returns: Dec[] = [];
  for (const split of ordered) {
    if (split.secondary2TotalReturn === undefined) {
      secondary2UnmeasuredReasons.push(
        `${split.splitId}: ${split.secondary2UnusableReason ?? "the registered Secondary 2 was not available for this split"}`,
      );
    } else {
      secondary2Returns.push(split.secondary2TotalReturn);
    }
  }
  if (ordered.length === 0) secondary2UnmeasuredReasons.push("no walk-forward split was pooled");

  // The second prong eats the same NAV. `candidateTotalReturn` is the candidate arm's own index, so a
  // carried-forward close on the split's last session distorts its endpoint exactly as it distorts the daily
  // returns behind the first prong - and `beats` could then be true on a number with the same unknown-sign
  // error. Withholding one prong and letting the other consume it would leave OWNER_REVIEW reachable
  // through the back door (Codex, PR #94).
  //
  // Withheld on ANY distorting session rather than only on the endpoint. The owner's decision was to
  // withhold on a gap, not to withhold on a gap in one particular place, and endpoint-only logic would be a
  // narrower rule than he chose - defensible, but not his.
  const gappedSplits = ordered.filter((split) => split.navDistortingSessions.length > 0);
  for (const split of gappedSplits) {
    secondary2UnmeasuredReasons.push(
      `${split.splitId}: a held instrument's bar was absent or carried forward on ${split.navDistortingSessions.length} session(s), which distorts the candidate's own total return that this prong is a difference of`,
    );
  }

  let secondary2: AggregateSecondary2 | undefined;
  if (secondary2UnmeasuredReasons.length === 0) {
    const candidateTotalReturn = linkTotalReturns(ordered.map((split) => split.candidateTotalReturn));
    const secondary2TotalReturn = linkTotalReturns(secondary2Returns);
    const excessReturn = candidateTotalReturn.minus(secondary2TotalReturn);
    secondary2 = {
      candidateTotalReturn: candidateTotalReturn.toFixed(8),
      secondary2TotalReturn: secondary2TotalReturn.toFixed(8),
      excessReturn: excessReturn.toFixed(8),
      beats: excessReturn.gt(0),
    };
  }

  // ---- F2 on the chain-linked curves --------------------------------------------------------------
  //
  // Computed for every charter, because F2 is a section 16.2 falsifier whatever else a version registers;
  // whether it gates promotion is `promotion_co_gates`' business, below.
  let drawdown: AggregateDrawdown | undefined;
  if (ordered.length > 0) {
    const withheldBecause: string[] = [];
    const missingLevels = ordered.filter((split) => split.candidateIndex.length === 0 || split.primaryIndex.length === 0);
    if (missingLevels.length > 0) {
      withheldBecause.push(
        `no candidate or primary-benchmark levels for ${missingLevels.map((split) => split.splitId).join(", ")}; a curve missing a window is not the aggregate set`,
      );
    }
    if (gappedSplits.length > 0) {
      withheldBecause.push(
        `${gappedSplits.length} of ${ordered.length} pooled split(s) carry a held instrument's absent or carried-forward bar, which distorts the candidate's levels by an amount and sign that depend on where the gap falls: ${gappedSplits.map((split) => split.splitId).join(", ")}`,
      );
    }
    // The benchmark's own gaps (Codex P1, PR #111). Withheld both ways like the candidate's, per the owner's gap
    // rule, though this one has a fixed direction: an absent or carried-forward mark can only shallow the
    // benchmark's drawdown, so publishing would bias F2 toward failing.
    const primaryGapped = ordered.filter((split) => split.primaryDistortingSessions.length > 0);
    if (primaryGapped.length > 0) {
      withheldBecause.push(
        `the primary benchmark's own bar is absent or carried forward in ${primaryGapped.length} pooled split(s), which can only understate its drawdown: ${primaryGapped.map((split) => split.splitId).join(", ")}`,
      );
    }
    const candidateCurve = chainLinkLevels(ordered.map((split) => split.candidateIndex));
    const primaryCurve = chainLinkLevels(ordered.map((split) => split.primaryIndex));
    if (candidateCurve === undefined || primaryCurve === undefined) {
      withheldBecause.push("a split's level series does not start at a positive level, so it cannot be chain-linked");
    }
    const candidateMaxDrawdown = candidateCurve === undefined ? ZERO : maxDrawdown(candidateCurve);
    const primaryMaxDrawdown = primaryCurve === undefined ? ZERO : maxDrawdown(primaryCurve);
    const limitRatio = new Dec(c.pass_fail.max_drawdown_ratio);
    const candidateAbs = candidateMaxDrawdown.abs();
    const primaryAbs = primaryMaxDrawdown.abs();
    drawdown = {
      candidateMaxDrawdown: candidateMaxDrawdown.toFixed(8),
      primaryMaxDrawdown: primaryMaxDrawdown.toFixed(8),
      ratio: primaryAbs.isZero() ? undefined : candidateAbs.div(primaryAbs).toFixed(8),
      limitRatio: limitRatio.toFixed(),
      // The per-split rule, literally: triggered when |candidate| > limit x |primary| (`drawdownCheck`).
      clears: withheldBecause.length > 0 ? undefined : !candidateAbs.gt(primaryAbs.times(limitRatio)),
      withheldBecause,
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
  } else {
    // Section 16.1 is a disjunction over two prongs, and a prong can now be genuinely unknown, so it is
    // evaluated in three-valued logic rather than by treating `undefined` as either outcome:
    //
    //   - EITHER prong passing gives owner review, whatever the other one did. Determinate even when the
    //     other prong is unknown, because section 16.1 asks only whether either passed.
    //   - BOTH prongs failing gives rejection. Both must be known to have failed.
    //   - Anything else is genuinely undetermined, and section 16.1 has no outcome for it.
    //
    // Collapsing unknown into either branch is the error this whole thread keeps finding: treating an
    // absent second prong as "does not beat" once made rejection the only reachable outcome.
    const primaryPasses = primaryMetric?.passes;
    const secondary2Beats = secondary2?.beats;
    if (primaryPasses === true || secondary2Beats === true) {
      verdict = "OWNER_REVIEW";
      verdictReasons.push(
        primaryPasses === true && secondary2Beats === true
          ? "both prongs passed"
          : primaryPasses === true
            ? "the primary metric passed on the aggregate walk-forward out-of-sample set"
            : "the strategy beat Secondary 2",
      );
      verdictReasons.push('section 16.1: "If either passes, the charter goes to owner review."');
      if (primaryPasses === false && secondary2Beats === true) {
        if (c.pass_fail.mixed_verdict === "OWNER_REVIEW_NEVER_ACTIVE") {
          verdictReasons.push(
            "the charter resolves this mixed case (pass_fail.mixed_verdict OWNER_REVIEW_NEVER_ACTIVE): owner review, which may end in REJECTED or a new charter version, never in ACTIVE on a failed primary metric",
          );
        } else {
          charterConflict =
            'Sections 16.1 and 17 disagree about this exact case. Section 16.1: "If either passes, the charter goes to owner review." Section 17: "If the metric fails, the charter goes to REJECTED, never to ACTIVE." The primary metric failed and Secondary 2 passed, so the two rules route the charter to different states. Which one governs is a charter question and therefore the owner\'s; it is not resolved here.';
          verdictReasons.push("this is the case sections 16.1 and 17 disagree on; see `charterConflict`");
        }
      }
    } else if (primaryPasses === false && secondary2Beats === false) {
      verdict = "REJECT";
      verdictReasons.push(
        "the strategy failed to improve the primary metric over the primary benchmark on the aggregate walk-forward out-of-sample set AND failed to beat Secondary 2",
      );
      verdictReasons.push('section 16.1: "if both fail, the hypothesis is rejected and the charter is marked REJECTED with results preserved."');
    } else {
      verdict = "UNMEASURED";
      if (primaryMetric === undefined) {
        verdictReasons.push(
          `the pooled series holds ${pooledStrategy.length} observation(s); a bootstrap interval needs at least two, and section 13 admits no point estimate without one`,
        );
      } else if (primaryPasses === undefined) {
        for (const why of primaryMetric.withheldBecause) verdictReasons.push(`the first prong is withheld: ${why}`);
      }
      if (secondary2 === undefined) {
        verdictReasons.push('the second prong is unmeasured, and section 16.1 rejects only "if both fail": absence is not failure');
      }
      if (primaryPasses === false && secondary2Beats === undefined) {
        verdictReasons.push("the primary metric failed, but with the second prong unmeasured it is not established that BOTH failed");
      }
    }
  }

  // ---- Section 17's computable REGISTERED -> ACTIVE conditions -----------------------------------
  //
  // The primary metric, plus every co-gate the charter registers - never instead of it. Three-valued, like
  // section 16.1: one known failure is enough to say the conditions are not met, while a pass needs every
  // condition known to pass, which the withheld deflated-Sharpe adjustment keeps unreachable for now.
  const coGates = (c.pass_fail.promotion_co_gates ?? []).map((id) => ({ id, clears: drawdown?.clears }));
  const promotionReasons: string[] = [];
  let promotionMet: boolean | undefined;
  const conditions = [primaryMetric?.passes, ...coGates.map((g) => g.clears)];
  if (!complete) {
    promotionMet = undefined;
    promotionReasons.push("the pool is not the whole walk-forward schedule, so no section 17 condition is read from it");
  } else if (conditions.some((v) => v === false)) {
    promotionMet = false;
    if (primaryMetric?.passes === false) promotionReasons.push("the primary metric failed: section 17 admits no ACTIVE without it");
    for (const g of coGates) if (g.clears === false) promotionReasons.push(`co-gate ${g.id} failed on the aggregate walk-forward set`);
  } else if (conditions.every((v) => v === true)) {
    promotionMet = true;
    promotionReasons.push("the primary metric passed and every registered co-gate cleared; the owner's written acceptance is still required");
  } else {
    promotionMet = undefined;
    if (primaryMetric?.passes === undefined) promotionReasons.push("the primary metric is unmeasured or withheld");
    for (const g of coGates) if (g.clears === undefined) promotionReasons.push(`co-gate ${g.id} is unmeasured or withheld`);
  }
  const promotion: AggregatePromotionConditions = {
    primaryMetricPasses: primaryMetric?.passes,
    coGates,
    met: promotionMet,
    reasons: promotionReasons,
  };

  // ---- Citability and caveats ---------------------------------------------------------------------
  const citabilityReasons: string[] = [];
  const promotionBlocking = new Set<string>();
  for (const split of ordered) {
    for (const code of split.promotionBlockingCodes) promotionBlocking.add(code);
    if (!split.citableAsEvidence) {
      for (const reason of split.citabilityReasons) citabilityReasons.push(`${split.splitId}: ${reason}`);
      if (split.citabilityReasons.length === 0) citabilityReasons.push(`${split.splitId}: not citable as promotion evidence`);
    }
  }
  const promotionBlockingCodes = [...promotionBlocking].sort();

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
      "The deflated-Sharpe adjustment section 13 registers for the trial count is NOT applied: section 15 computes it with N = 72 trials and the observed cross-trial variance, and one evaluation run produces neither. It is an added hurdle rather than a re-scaling, so it can take a pass away and can never grant one - which is why a failing first prong is acted on here and a passing one is withheld rather than merely annotated.",
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
  if (drawdown !== undefined && ordered.length > 1) {
    evidenceCaveats.push(
      "F2 reads chain-linked curves, so the same restart from cash shapes them: during each window's warm-up the candidate holds cash and cannot draw down while the primary benchmark stays invested and can. The effect's direction is not fixed, but it acts at every boundary.",
    );
  }
  if (secondary2 !== undefined && c.benchmarks.secondary_2_readings === undefined) {
    for (const reading of SECONDARY_2_OPEN_READINGS) evidenceCaveats.push(reading);
  }

  const citableAsEvidence = citabilityReasons.length === 0 && ordered.length > 0;

  /**
   * Everything this verdict reports, except its own hash.
   *
   * The hash covers **the whole payload**, not a hand-picked subset of it. The subset was wrong three
   * review rounds running on PR #94, each time for the same reason and each time found by someone else:
   * first the charter was identified by version string rather than by content hash, then evidence
   * eligibility was missing, then the two linked return totals behind the excess. Every one of those was a
   * field the aggregate REPORTED and did not hash, so two materially different published results could
   * share an identity - and `aggregateHash` is what a PR body quotes to name a result.
   *
   * Curating the list again would only move the next omission somewhere else. The rule that actually holds
   * is structural: if a reader can see it, it is part of what the verdict says, so it is part of what the
   * verdict IS. Hashing the payload makes that true by construction rather than by vigilance, and a field
   * added here later is covered without anyone remembering to add it.
   *
   * One consequence, accepted deliberately: a purely presentational change - new wording in
   * `verdictReasons`, an added `evidenceCaveats` entry - moves the hash. That is the right side to err on.
   * A caveat is part of what the result tells an owner, and `aggregateVersion` is there to mark a shape
   * change when one happens.
   */
  const payload: Omit<AggregateWalkForward, "aggregateHash"> = {
    aggregateVersion: AGGREGATE_VERSION,
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    charterHash: input.charterHash,
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
    drawdown,
    promotion,
    verdict,
    verdictReasons,
    charterConflict,
    citableAsEvidence,
    citabilityReasons,
    promotionBlockingCodes,
    evidenceCaveats,
  };

  return { ...payload, aggregateHash: `sha256:${hashJson(payload)}` };
}
