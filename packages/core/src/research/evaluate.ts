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
import { buildResultReport } from "./report.ts";
import { splitPlan, type SplitKind } from "./walkforward.ts";
import { enumerateGrid } from "./robustness.ts";

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

export const EVALUATION_VERSION = 1;

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
  arms: { arm: string; totalReturn: string; maxDrawdown: string }[];
};

export type EvaluationReport = {
  evaluationVersion: number;
  strategyId: string;
  charterVersion: string;
  charterHash: string;
  planHash: string;
  barsSourceId: string;
  /** Whether the charter itself may be registered (empty registrability reasons). */
  registrable: boolean;
  registrabilityReasons: string[];
  /** True only if every split is citable as promotion evidence; one uncitable split makes the run uncitable. */
  citableAsEvidence: boolean;
  /** Union of promotion-blocking data-quality codes seen across all splits. */
  promotionBlockingCodes: string[];
  splits: SplitEvaluation[];
  reportHash: string;
};

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
};

export function runEvaluation(input: RunEvaluationInput): EvaluationReport {
  const c = input.charter;
  // Throws SplitRangeError if any design/walk-forward/recent window overlaps the sealed holdout.
  const plan = splitPlan(c);
  const trialLedgerCount = enumerateGrid(c).trialCount;
  const initialCash = input.initialCash ?? RESEARCH_INITIAL_CASH;
  const params = backtestParamsFromCharter(c);
  const costs = costsFromCharter(c, "base");

  const splits: SplitEvaluation[] = [];
  const promotionBlocking = new Set<string>();
  let allCitable = true;

  for (const split of plan.splits) {
    // Defensive: splitPlan never returns the holdout, but never evaluate one even if that ever regressed.
    if (split.kind === "HOLDOUT") continue;

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
      arms: report.arms.map((a) => ({ arm: a.arm, totalReturn: a.totalReturn.toFixed(8), maxDrawdown: a.maxDrawdown.toFixed(8) })),
    });
  }

  const barsSourceId = input.barsSourceId ?? DEFAULT_BARS_SOURCE_ID;
  const promotionBlockingCodes = [...promotionBlocking].sort();
  const body = {
    evaluationVersion: EVALUATION_VERSION,
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    charterHash: input.charterHash,
    planHash: plan.planHash,
    barsSourceId,
    splits: splits.map((s) => [s.splitId, s.reportHash, s.resultHash]),
    promotionBlockingCodes,
  };
  return {
    evaluationVersion: EVALUATION_VERSION,
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    charterHash: input.charterHash,
    planHash: plan.planHash,
    barsSourceId,
    registrable: input.registrabilityReasons.length === 0,
    registrabilityReasons: [...input.registrabilityReasons],
    citableAsEvidence: allCitable && splits.length > 0,
    promotionBlockingCodes,
    splits,
    reportHash: `sha256:${hashJson(body)}`,
  };
}
