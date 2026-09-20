import { Dec, hashJson, type IsoDate } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { ReadOnlyPointInTime } from "../data/pit/types.ts";
import { blocksPromotionEvidence } from "../data/quality.ts";
import { DEFAULT_BARS_SOURCE_ID } from "../market/series.ts";
import type { Charter } from "../strategy/charter.ts";
import {
  backtestParamsFromCharter,
  costsFromCharter,
  reportBenchmarkSeries,
  runBacktest,
  type BacktestInput,
} from "./backtest.ts";
import { buildResultReport, sharpeInputSeries, type ArmMetrics, type ResultReport } from "./report.ts";
import { splitPlan, type SplitKind } from "./walkforward.ts";
import { enumerateGrid } from "./robustness.ts";
import { aggregateWalkForward, type AggregateSplitInput, type AggregateWalkForward } from "./aggregate.ts";

/**
 * Operator entry point for a deterministic evaluation run (PLAN.md Phase 2).
 *
 * It wires three already-tested pieces into one command: `splitPlan` resolves the charter's design,
 * walk-forward and recent splits; `runBacktest` scores each; `buildResultReport` turns each into a report.
 * It computes numbers - it neither registers an experiment nor opens the sealed holdout.
 *
 * Two boundaries hold by construction:
 *   - The sealed holdout is never evaluated. `splitPlan().splits` contains only DESIGN/WALK_FORWARD/RECENT,
 *     `splitPlan` throws if any of them overlaps the holdout, and this loop additionally skips any HOLDOUT
 *     split. `holdoutSplit` is never called from here (opening the holdout is outside standing authorization).
 *   - A run over promotion-ineligible data is reported as such. `runBacktest.citableAsEvidence` covers the
 *     charter/integrity reasons (registrability, survivorship, optimistic delay, synthetic missing data,
 *     execution-order violations); the data-quality promotion block (e.g. UNVERIFIED_SINGLE_SOURCE, D-49)
 *     lives in the run labels and is folded in here. A run is citable as promotion evidence only when both
 *     are clean.
 */

// 4: the report carries `aggregate`, ALPHA_CHARTER section 16.1 evaluated once over the pooled walk-forward
// out-of-sample set (D-51 step 2). An added output field with its own hash inside the evaluation's hashed
// body, so the version moves with it.
export const EVALUATION_VERSION = 4;

/**
 * Nominal research notional. Every reported metric is a ratio (Sharpe, total return, drawdown), so the level
 * is immaterial to the result; it is fixed here for reproducibility rather than exposed as an operator knob.
 */
export const RESEARCH_INITIAL_CASH = new Dec("100000");

export type SplitEvaluation = {
  splitId: string;
  kind: SplitKind;
  evaluation: { start: IsoDate; end: IsoDate };
  reportId: string;
  reportHash: string;
  resultHash: string;
  decisions: number;
  /** Citable as promotion evidence: integrity-clean AND free of promotion-blocking data codes. */
  citableAsEvidence: boolean;
  /** Charter/integrity reasons the run may not be cited (from the backtest). */
  citabilityReasons: string[];
  /** Data-quality codes that bar promotion evidence for this split (e.g. UNVERIFIED_SINGLE_SOURCE). */
  promotionBlockingCodes: string[];
  labels: string[];
  primaryMetric: { name: string; pointEstimate: number; lower: number; upper: number; threshold: number; passes: boolean };
  /**
   * ALPHA_CHARTER section 13's secondary risk metrics, per arm and per benchmark.
   *
   * `buildResultReport` has always computed CAGR, Calmar and the drawdowns; this surface dropped all but
   * total return and max drawdown, so the only number an operator could read from `research evaluate` was
   * the primary Sharpe difference. The charter's own hypothesis (section 4) claims the strategy raises
   * "Sharpe and Calmar", and section 13 lists Calmar among the secondary risk metrics - neither was
   * reachable from the command that produces the evidence.
   */
  arms: ArmSummary[];
  benchmarks: ArmSummary[];
  /** ALPHA_CHARTER F2: strategy max drawdown against `max_drawdown_ratio` x the primary benchmark's. */
  drawdown: DrawdownCheck | undefined;
  /**
   * Sharpe difference against the benchmark the code builds as `APPROX_AVERAGE_EXPOSURE_PRIMARY`.
   *
   * **This is NOT the charter's registered Secondary 2, and must not be read as section 16.1's second
   * prong.** Section 11 defines Secondary 2 as "VTI scaled to a 10% ex-ante volatility target with the
   * same 63-day estimator, remainder in BIL" - a dynamically re-scaled series. `buildResultReport` instead
   * holds VTI at the strategy's *constant average* realized equity weight, and says so ("Approximated
   * here"). That is a coarser version of Secondary 1 (which uses the same weights per session), not a
   * volatility-targeted series at all, and it can differ materially in both volatility and return.
   *
   * It is surfaced as a diagnostic because it is what the code computes, and naming it honestly is better
   * than leaving an unlabelled number in the report. Evaluating section 16.1 needs Secondary 2 to be
   * implemented first; see `docs/analysis/2026-09-20-d51-primary-metric.md`.
   */
  approximateVersusAverageExposureBenchmark: number | undefined;
  /**
   * ALPHA_CHARTER section 16.1's second prong, against the **registered** Secondary 2: the strategy's
   * **excess return** over "VTI scaled to a 10% ex-ante volatility target with the same 63-day estimator,
   * remainder in BIL". Positive means trend selection adds something beyond volatility control alone.
   *
   * Excess return rather than a Sharpe difference, per section 13's registered metric list; the owner
   * resolved that ambiguity on 2026-09-20. A decimal string, because it feeds a rejection verdict.
   *
   * Secondary 2 is built as its own index with each rebalance session split at the open, so this number is
   * free of the fill-timing bias that made it unpublishable earlier in this work.
   *
   * Still a **per-split** number. Section 16.1's verdict is defined on the aggregate walk-forward
   * out-of-sample set, so this is an input to that verdict, never the verdict itself, and no §16.1 outcome
   * is emitted here. `undefined` when Secondary 2 could not be built (the primary is not a risk ETF, so the
   * registered estimator produces no volatility for it); nothing is substituted in its place.
   */
  primaryVersusSecondary2: string | undefined;
  /**
   * Which of the charter's falsifiers this split actually evaluated - which is **F2 only**.
   *
   * **F1 is not evaluable per split.** Section 13 defines the primary-metric pass rule "on the aggregate
   * walk-forward out-of-sample set". DESIGN is in-sample and a single walk-forward window is not the
   * aggregate, so the adjacent `primaryMetric.passes` is a per-window **diagnostic**, not an F1 verdict.
   * Saying a split "fails F1" is a category error.
   *
   * F3, F4 and F5 need the adverse-cost and extra-delay tiers, the drop-best-year refit, and the full
   * sensitivity grid; F6 is prospective. None is produced by a single evaluation run.
   *
   * Section 16.1's decisive falsifier is absent for the same aggregate-scope reason, and additionally
   * because the registered Secondary 2 it names is not implemented - see
   * `docs/analysis/2026-09-20-d51-primary-metric.md`.
   *
   * F2 is listed as evaluated because section 16.2 states it without an aggregate qualifier, so a
   * per-window drawdown ratio is a faithful reading. If that is wrong it belongs in the same bucket.
   */
  falsifiersEvaluated: string[];
  falsifiersNotEvaluated: string[];
};

export type ArmSummary = {
  arm: string;
  totalReturn: string;
  cagr: string;
  maxDrawdown: string;
  /** CAGR over absolute max drawdown. `undefined` when the drawdown is zero. */
  calmar: string | undefined;
  annualizedSharpeVsCash: number;
};

export type DrawdownCheck = {
  strategy: string;
  primaryBenchmark: string;
  /** |strategy| / |benchmark|. Below `limitRatio` passes. */
  ratio: string;
  limitRatio: string;
  /** True when F2 is triggered, i.e. the strategy's drawdown exceeds the allowed multiple. */
  f2Triggered: boolean;
};

/** Shape one arm or benchmark's ALPHA_CHARTER section 13 metrics for the operator surface. */
function armSummary(a: ArmMetrics): ArmSummary {
  return {
    arm: a.arm,
    totalReturn: a.totalReturn.toFixed(8),
    cagr: a.cagr.toFixed(8),
    maxDrawdown: a.maxDrawdown.toFixed(8),
    calmar: a.calmar === undefined ? undefined : a.calmar.toFixed(8),
    annualizedSharpeVsCash: a.sharpeVsCash,
  };
}

/**
 * ALPHA_CHARTER F2, computed the same way `evaluateFalsifiers` computes it: drawdowns are non-positive,
 * so the strategy passes when |strategy| <= max_drawdown_ratio x |primary benchmark|.
 */
function drawdownCheck(c: Charter, report: ResultReport): DrawdownCheck | undefined {
  const strategy = report.arms.find((a) => a.arm === "B1_DETERMINISTIC");
  const benchmark = report.benchmarks.find((b) => b.arm === `${c.benchmarks.primary}_TR`);
  if (strategy === undefined || benchmark === undefined) return undefined;
  const limitRatio = new Dec(c.pass_fail.max_drawdown_ratio);
  const benchAbs = benchmark.maxDrawdown.abs();
  const strategyAbs = strategy.maxDrawdown.abs();
  return {
    strategy: strategy.maxDrawdown.toFixed(8),
    primaryBenchmark: benchmark.maxDrawdown.toFixed(8),
    ratio: benchAbs.isZero() ? "undefined" : strategyAbs.div(benchAbs).toFixed(8),
    limitRatio: limitRatio.toFixed(),
    f2Triggered: strategyAbs.gt(benchAbs.times(limitRatio)),
  };
}

export type EvaluationReport = {
  evaluationVersion: number;
  strategyId: string;
  charterVersion: string;
  charterHash: string;
  planHash: string;
  barsSourceId: string;
  /** The split kinds actually evaluated. Narrowed when the caller passes a splitKinds filter. */
  splitKinds: SplitKind[];
  /** Whether the charter itself may be registered (empty registrability reasons). */
  registrable: boolean;
  registrabilityReasons: string[];
  /** True only if every split is citable as promotion evidence; one uncitable split makes the run uncitable. */
  citableAsEvidence: boolean;
  /** Union of promotion-blocking data-quality codes seen across all splits. */
  promotionBlockingCodes: string[];
  splits: SplitEvaluation[];
  /**
   * ALPHA_CHARTER section 16.1 at the scope the charter defines it: one verdict over the walk-forward
   * out-of-sample splits pooled (`research/aggregate.ts`).
   *
   * `undefined` when no walk-forward split ran - not "no verdict yet" hidden inside a verdict. A run
   * narrowed to `--split design` produces no aggregate at all, because the design window is in-sample and
   * contributes nothing to the set section 16.1 names.
   *
   * There is deliberately no per-split counterpart. Sections 13 and 16.1 are both scoped to the aggregate
   * set, so a per-split verdict would state several contradictory answers where the charter registers one,
   * and would state one of them over in-sample data.
   */
  aggregate: AggregateWalkForward | undefined;
  reportHash: string;
};

/**
 * Progress event emitted around each split and at the run's start and end. A side channel for long runs
 * (the report itself is unaffected): a caller can print it to stderr so an operator sees the sweep advance.
 */
export type EvaluationProgress =
  | { phase: "start"; total: number }
  | { phase: "split-start"; total: number; index: number; splitId: string; kind: SplitKind }
  | { phase: "split-done"; total: number; index: number; splitId: string; kind: SplitKind }
  | { phase: "done"; total: number };

export type RunEvaluationInput = {
  charter: Charter;
  charterHash: string;
  /** From `registrabilityReasons(charter)`; threaded into every run so results reflect registrability. */
  registrabilityReasons: readonly string[];
  pit: ReadOnlyPointInTime;
  calendar: ExchangeCalendar;
  /** Defaults to RESEARCH_INITIAL_CASH; the level does not change any reported ratio. */
  initialCash?: Dec;
  /** Optional bars source override (e.g. tiingo.eod.bars.1d); defaults to the charter's default source. */
  barsSourceId?: string;
  /** Restrict which split kinds run (e.g. just DESIGN, or just RECENT). Omit to run all non-holdout splits. */
  splitKinds?: readonly SplitKind[];
  /** Optional progress callback for long runs. A side channel only; it does not affect the report. */
  onProgress?: (event: EvaluationProgress) => void;
};

export function runEvaluation(input: RunEvaluationInput): EvaluationReport {
  const c = input.charter;
  // Throws SplitRangeError if any design/walk-forward/recent window overlaps the sealed holdout.
  const plan = splitPlan(c);
  const trialLedgerCount = enumerateGrid(c).trialCount;
  const initialCash = input.initialCash ?? RESEARCH_INITIAL_CASH;
  const params = backtestParamsFromCharter(c);
  const costs = costsFromCharter(c, "base");

  // Never the sealed holdout; optionally narrow to the requested kinds. Order follows splitPlan (design,
  // walk-forward schedule, recent).
  const selected = plan.splits.filter(
    (s) => s.kind !== "HOLDOUT" && (input.splitKinds === undefined || input.splitKinds.includes(s.kind)),
  );
  const notify = input.onProgress ?? (() => undefined);

  const splits: SplitEvaluation[] = [];
  // What the aggregate reading of sections 13 and 16.1 pools. Collected inside the loop, where the backtest
  // and its report are both in hand, rather than reconstructed afterwards from `SplitEvaluation`: the paired
  // excess series and the arm/benchmark total returns are inputs to one statistic at a wider scope, and
  // rebuilding them from the rounded strings the operator surface carries would make the aggregate a second
  // statistic that merely resembles the per-split one.
  const aggregateInputs: AggregateSplitInput[] = [];
  const promotionBlocking = new Set<string>();
  let allCitable = true;

  notify({ phase: "start", total: selected.length });
  for (const [index, split] of selected.entries()) {
    notify({ phase: "split-start", total: selected.length, index, splitId: split.id, kind: split.kind });

    const btInput: BacktestInput = {
      charter: c,
      charterHash: input.charterHash,
      pit: input.pit,
      calendar: input.calendar,
      from: split.evaluation.start,
      to: split.evaluation.end,
      initialCash,
      costs,
      params,
      registrabilityReasons: input.registrabilityReasons,
      ...(input.barsSourceId === undefined ? {} : { barsSourceId: input.barsSourceId }),
    };
    const bt = runBacktest(btInput);
    const { primary, cash } = reportBenchmarkSeries(btInput);
    const report = buildResultReport({ charter: c, backtest: bt, primary, cash, trialLedgerCount });

    const splitBlocking = blocksPromotionEvidence(bt.labels);
    for (const code of splitBlocking) promotionBlocking.add(code);
    const splitCitable = report.citableAsEvidence && splitBlocking.length === 0;
    if (!splitCitable) allCitable = false;

    splits.push({
      splitId: split.id,
      kind: split.kind,
      evaluation: split.evaluation,
      reportId: report.reportId,
      reportHash: report.reportHash,
      resultHash: bt.resultHash,
      decisions: report.decisions,
      citableAsEvidence: splitCitable,
      citabilityReasons: report.citabilityReasons,
      promotionBlockingCodes: [...splitBlocking],
      labels: report.labels,
      primaryMetric: {
        name: report.primaryMetric.name,
        pointEstimate: report.primaryMetric.pointEstimate,
        lower: report.primaryMetric.interval.lower,
        upper: report.primaryMetric.interval.upper,
        threshold: report.primaryMetric.threshold,
        passes: report.primaryMetric.passes,
      },
      arms: report.arms.map(armSummary),
      benchmarks: report.benchmarks.map(armSummary),
      drawdown: drawdownCheck(c, report),
      approximateVersusAverageExposureBenchmark: report.primaryVersusVolatilityControlled,
      primaryVersusSecondary2: report.primaryVersusSecondary2?.toFixed(8),
      falsifiersEvaluated: ["F2"],
      falsifiersNotEvaluated: ["F1", "F3", "F4", "F5", "F6"],
    });

    if (split.kind === "WALK_FORWARD") {
      const candidateArm = bt.arms["B1_DETERMINISTIC"];
      const candidate = report.arms.find((a) => a.arm === "B1_DETERMINISTIC");
      // `buildResultReport` throws without this arm, so reaching here without it is impossible. The check is
      // written as a throw rather than as a `?? ZERO` fallback because the fallback would pool a fabricated
      // zero return into a decisive comparison instead of failing.
      if (candidateArm === undefined || candidate === undefined) {
        throw new RangeError(`walk-forward split ${split.id} produced no B1_DETERMINISTIC arm`);
      }
      // By the unqualified name, the same lookup `buildResultReport` uses for the per-split prong. An index
      // published as `SECONDARY_2_VOL_TARGET_PRIMARY__INEXACT` deliberately does not match, so a withheld or
      // inexact comparator leaves the aggregate prong unmeasured rather than quietly entering the chain-link.
      const secondary2 = report.benchmarks.find((b) => b.arm === "SECONDARY_2_VOL_TARGET_PRIMARY");
      const unusable =
        secondary2 !== undefined
          ? undefined
          : bt.secondary2InexactReasons.length > 0
            ? bt.secondary2InexactReasons.join("; ")
            : "the registered Secondary 2 was not built for this window";
      aggregateInputs.push({
        splitId: split.id,
        kind: split.kind,
        sessions: bt.sessions,
        sharpeInputs: sharpeInputSeries(candidateArm.index.points, primary.points, cash.points),
        candidateTotalReturn: candidate.totalReturn,
        secondary2TotalReturn: secondary2?.totalReturn,
        secondary2UnusableReason: unusable,
        citableAsEvidence: splitCitable,
        citabilityReasons: report.citabilityReasons,
        promotionBlockingCodes: [...splitBlocking],
      });
    }

    notify({ phase: "split-done", total: selected.length, index, splitId: split.id, kind: split.kind });
  }
  notify({ phase: "done", total: selected.length });

  // Every walk-forward split the charter's schedule declares, whether or not this run was narrowed to a
  // subset. Read from `plan`, not from `selected`, because completeness is exactly what a `--split` filter
  // destroys and what the aggregate has to notice.
  const plannedWalkForwardSplitIds = plan.splits.filter((s) => s.kind === "WALK_FORWARD").map((s) => s.id);
  const aggregate =
    aggregateInputs.length === 0
      ? undefined
      : aggregateWalkForward({
          charter: c,
          charterHash: input.charterHash,
          splits: aggregateInputs,
          plannedSplitIds: plannedWalkForwardSplitIds,
        });

  const barsSourceId = input.barsSourceId ?? DEFAULT_BARS_SOURCE_ID;
  const promotionBlockingCodes = [...promotionBlocking].sort();
  const splitKinds = [...new Set(splits.map((s) => s.kind))];
  const body = {
    evaluationVersion: EVALUATION_VERSION,
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    charterHash: input.charterHash,
    planHash: plan.planHash,
    barsSourceId,
    splitKinds,
    splits: splits.map((s) => [s.splitId, s.reportHash, s.resultHash]),
    promotionBlockingCodes,
    aggregate: aggregate?.aggregateHash ?? "none",
  };
  return {
    evaluationVersion: EVALUATION_VERSION,
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    charterHash: input.charterHash,
    planHash: plan.planHash,
    barsSourceId,
    splitKinds,
    registrable: input.registrabilityReasons.length === 0,
    registrabilityReasons: [...input.registrabilityReasons],
    citableAsEvidence: allCitable && splits.length > 0,
    promotionBlockingCodes,
    splits,
    aggregate,
    reportHash: `sha256:${hashJson(body)}`,
  };
}
