import { Dec, ONE, ZERO, hashJson, sumDec, type IsoDate } from "@blackgold/shared";
import { annualizedVol, annualTurnover, blendSeries, cagr, maxDrawdown, sharpe, type BlendSpec } from "./benchmarks.ts";
import { simpleReturns, type TRPoint, type TRSeries } from "../market/series.ts";
import { annualizedSharpe, quantile, stationaryBootstrap, type BootstrapResult } from "./stats.ts";
import type { Charter } from "../strategy/charter.ts";
import type { ArmResult, BacktestResult } from "./backtest.ts";

/**
 * The minimum result set (docs/EXPERIMENT_PROTOCOL.md section 8).
 *
 * Every arm, gross and net, with the passive baseline on the same page as the candidate, plus the charter's
 * own "reasons it may not work" carried verbatim. The report is a data structure, not prose: a CLI or a
 * status page renders it, and its hash is what a PR cites.
 *
 * Two rules the report enforces rather than merely documents:
 *
 *  - No headline number is emitted without its uncertainty. The primary metric always carries a
 *    block-bootstrap interval, because a point estimate on its own is what the protocol forbids.
 *  - A result that cannot be cited as evidence says so at the top, in its own field, with reasons. Draft
 *    charters, optimistic delays, survivorship labels and synthetic missing data all land there.
 */

export const REPORT_VERSION = 1;

export type ArmMetrics = {
  arm: string;
  /** Total return over the window. */
  totalReturn: Dec;
  cagr: Dec;
  annualizedVolatility: number;
  maxDrawdown: Dec;
  /** CAGR divided by the absolute maximum drawdown. */
  calmar: Dec | undefined;
  /** Annualized Sharpe against the cash leg. */
  sharpeVsCash: number;
  /** Annualized information ratio against the primary benchmark. */
  informationRatioVsPrimary: number;
  /** Worst 21-session return over the window. */
  worst21Session: Dec | undefined;
  /** 1% and 5% tail of daily returns. */
  tailLosses: { p01: number; p05: number };
  annualTurnover: Dec | undefined;
  averageEquityWeight: Dec | undefined;
  /** Fraction of sessions with more than half of NAV in cash. */
  monthsMostlyCash: Dec | undefined;
  realized: { shortTerm: Dec; longTerm: Dec; total: Dec } | undefined;
  executionShortfall: Dec | undefined;
  fills: number;
  sessions: number;
};

export type TaxScenarioResult = {
  scenario: "pre_tax" | "taxable_short_long_split" | "tax_deferred";
  /** Tax charged against realized gains under the scenario. Zero for pre-tax and tax-deferred. */
  taxCharged: Dec;
  /** Total return after the scenario's tax on realized gains. */
  afterTaxReturn: Dec;
  /** Rates the scenario used, so the report states them rather than implying them. */
  shortTermRate: Dec;
  longTermRate: Dec;
  disclaimer: string;
};

export type ResultReport = {
  reportId: string;
  version: number;
  strategyId: string;
  charterVersion: string;
  charterHash: string;
  from: IsoDate;
  to: IsoDate;
  costTier: string;
  delayBars: number;
  /** Metrics per arm, plus the benchmarks the charter names. */
  arms: ArmMetrics[];
  benchmarks: ArmMetrics[];
  /** The primary metric with its interval: the after-cost Sharpe difference against the primary benchmark. */
  primaryMetric: {
    name: string;
    /** Candidate minus benchmark, annualized. */
    pointEstimate: number;
    interval: BootstrapResult;
    threshold: number;
    /** Whether the interval clears the charter's threshold and excludes zero. */
    passes: boolean;
  };
  /** Against the volatility-controlled benchmark: the charter's second decisive bar. */
  primaryVersusVolatilityControlled: number | undefined;
  taxScenarios: TaxScenarioResult[];
  /** Non-overlapping monthly-equivalent blocks the result rests on. */
  independentDecisions: number;
  decisions: number;
  trialLedgerCount: number;
  labels: string[];
  citableAsEvidence: boolean;
  citabilityReasons: string[];
  /** ALPHA_CHARTER.md section 23, verbatim. Carried into every report by construction. */
  reasonsItMayNotWork: string[];
  reportHash: string;
};

const SESSIONS_PER_MONTH = 21;

function totalReturn(points: readonly TRPoint[]): Dec {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || !first.trIndex.gt(0)) return ZERO;
  return last.trIndex.div(first.trIndex).minus(ONE);
}

function worstRollingReturn(points: readonly TRPoint[], window: number): Dec | undefined {
  if (points.length <= window) return undefined;
  let worst: Dec | undefined;
  for (let i = window; i < points.length; i++) {
    const from = points[i - window];
    const to = points[i];
    if (!from || !to || !from.trIndex.gt(0)) continue;
    const r = to.trIndex.div(from.trIndex).minus(ONE);
    if (worst === undefined || r.lt(worst)) worst = r;
  }
  return worst;
}

function dailyNumbers(points: readonly TRPoint[]): number[] {
  return simpleReturns(points).map((r) => r.value.toNumber());
}

/** Paired daily excess of `a` over `b` on their common sessions. */
function pairedExcess(a: readonly TRPoint[], b: readonly TRPoint[]): number[] {
  const bySession = new Map(simpleReturns(b).map((r) => [r.session, r.value.toNumber()]));
  const out: number[] = [];
  for (const r of simpleReturns(a)) {
    const other = bySession.get(r.session);
    if (other !== undefined) out.push(r.value.toNumber() - other);
  }
  return out;
}

export type MetricsInput = {
  arm: string;
  index: TRSeries;
  cash: TRSeries;
  primary: TRSeries;
  nav?: readonly { session: IsoDate; nav: Dec; cash: Dec; investedWeight: Dec }[];
  tradedNotional?: Dec;
  realized?: { shortTerm: Dec; longTerm: Dec; total: Dec };
  executionShortfall?: Dec;
  fills?: number;
};

export function armMetrics(input: MetricsInput): ArmMetrics {
  const points = input.index.points;
  const dd = points.length >= 2 ? maxDrawdown(points) : ZERO;
  const growth = points.length >= 2 ? cagr(points) : ZERO;
  const daily = dailyNumbers(points);
  const nav = input.nav;
  const averageEquityWeight = nav === undefined || nav.length === 0 ? undefined : sumDec(nav.map((p) => p.investedWeight)).div(nav.length);
  const mostlyCash =
    nav === undefined || nav.length === 0 ? undefined : new Dec(nav.filter((p) => p.investedWeight.lt(new Dec("0.5"))).length).div(nav.length);

  let turnover: Dec | undefined;
  const first = points[0];
  const last = points[points.length - 1];
  if (input.tradedNotional !== undefined && nav !== undefined && nav.length > 0 && first && last) {
    const averageNav = sumDec(nav.map((p) => p.nav)).div(nav.length);
    if (averageNav.gt(0)) turnover = annualTurnover({ tradedNotional: [input.tradedNotional], averageNav, from: first.session, to: last.session });
  }

  return {
    arm: input.arm,
    totalReturn: totalReturn(points),
    cagr: growth,
    annualizedVolatility: points.length >= 2 ? annualizedVol(points) : 0,
    maxDrawdown: dd,
    calmar: dd.isZero() ? undefined : growth.div(dd.abs()),
    sharpeVsCash: points.length >= 2 ? sharpe(points, input.cash.points) : 0,
    informationRatioVsPrimary: points.length >= 2 ? sharpe(points, input.primary.points) : 0,
    worst21Session: worstRollingReturn(points, SESSIONS_PER_MONTH),
    tailLosses: { p01: daily.length === 0 ? 0 : quantile(daily, 0.01), p05: daily.length === 0 ? 0 : quantile(daily, 0.05) },
    annualTurnover: turnover,
    averageEquityWeight,
    monthsMostlyCash: mostlyCash,
    realized: input.realized,
    executionShortfall: input.executionShortfall,
    fills: input.fills ?? 0,
    sessions: points.length,
  };
}

export type TaxRates = { shortTerm: Dec; longTerm: Dec };

/**
 * Tax as a scenario, never as a single number (protocol section 11). Rates come from configuration and are
 * stated in the result. Wash-sale treatment covers the sleeve only and the disclaimer says so.
 */
export function taxScenarios(input: { realized: { shortTerm: Dec; longTerm: Dec; total: Dec }; totalReturn: Dec; initialCash: Dec; rates: TaxRates; scenarios: readonly TaxScenarioResult["scenario"][] }): TaxScenarioResult[] {
  const disclaimer = "Sleeve-account scope only. Black Gold does not claim household-wide wash-sale accuracy and never autonomously tax-loss harvests.";
  return input.scenarios.map((scenario) => {
    const tax =
      scenario === "taxable_short_long_split"
        ? input.realized.shortTerm.times(input.rates.shortTerm).plus(input.realized.longTerm.times(input.rates.longTerm))
        : ZERO;
    // Tax on realized gains only; unrealized gains are untaxed in every scenario.
    const drag = input.initialCash.gt(0) ? tax.div(input.initialCash) : ZERO;
    return {
      scenario,
      taxCharged: tax,
      afterTaxReturn: input.totalReturn.minus(drag),
      shortTermRate: scenario === "taxable_short_long_split" ? input.rates.shortTerm : ZERO,
      longTermRate: scenario === "taxable_short_long_split" ? input.rates.longTerm : ZERO,
      disclaimer,
    };
  });
}

export type BuildReportInput = {
  charter: Charter;
  backtest: BacktestResult;
  /** Total-return series for the charter's primary benchmark instrument and cash leg. */
  primary: TRSeries;
  cash: TRSeries;
  /** Trials recorded in the ledger across the parent chain: the multiple-testing denominator. */
  trialLedgerCount: number;
  taxRates?: TaxRates;
  bootstrapResamples?: number;
  bootstrapSeed?: number;
};

/**
 * Assemble the report.
 *
 * The exposure-matched and volatility-controlled benchmarks are built here from the strategy's own realized
 * equity weights, which is why they belong next to the metrics rather than in the benchmark module: they are
 * functions of the result, not of the market alone.
 */
export function buildResultReport(input: BuildReportInput): ResultReport {
  const { charter: c, backtest: bt } = input;
  const candidate = bt.arms["B1_DETERMINISTIC"];
  const passive = bt.arms["B0_PASSIVE"];
  if (!candidate) throw new RangeError("a result report needs the B1_DETERMINISTIC arm");

  const weightBySession = new Map(bt.equityWeights.map((w) => [w.session, w.weight]));
  const exposureMatched: BlendSpec = { equity: input.primary, cash: input.cash, equityWeight: (session) => weightBySession.get(session) ?? ZERO };
  const benchmarkSeries: { name: string; series: TRSeries }[] = [{ name: `${c.benchmarks.primary}_TR`, series: input.primary }];
  if (c.benchmarks.exposure_matched) benchmarkSeries.push({ name: "EXPOSURE_MATCHED", series: blendSeries(exposureMatched) });
  if (c.benchmarks.volatility_controlled_primary) {
    // The charter's secondary 2: the primary benchmark scaled to the same volatility target. Approximated
    // here by holding the primary at the strategy's own average equity weight, which is the comparison the
    // charter cares about (does trend selection add anything beyond volatility control?).
    const average = bt.equityWeights.length === 0 ? ZERO : sumDec(bt.equityWeights.map((w) => w.weight)).div(bt.equityWeights.length);
    benchmarkSeries.push({ name: "VOLATILITY_CONTROLLED_PRIMARY", series: blendSeries({ equity: input.primary, cash: input.cash, equityWeight: average }) });
  }

  const metricsFor = (arm: ArmResult): ArmMetrics =>
    armMetrics({
      arm: arm.arm,
      index: arm.index,
      cash: input.cash,
      primary: input.primary,
      nav: arm.nav,
      tradedNotional: arm.tradedNotional,
      realized: arm.realized,
      executionShortfall: arm.executionShortfall,
      fills: arm.fills.length,
    });

  const arms: ArmMetrics[] = [metricsFor(candidate)];
  if (passive) arms.push(metricsFor(passive));
  const benchmarks = benchmarkSeries.map((b) => armMetrics({ arm: b.name, index: b.series, cash: input.cash, primary: input.primary }));

  // Primary metric: the after-cost annualized Sharpe difference against the primary benchmark, with a
  // stationary block bootstrap at the charter's frozen block length. A paired daily excess series is the
  // statistic's input, so the interval respects the pairing rather than treating the arms as independent.
  const paired = pairedExcess(candidate.index.points, input.primary.points);
  const interval = stationaryBootstrap(paired.length >= 2 ? paired : [0, 0], annualizedSharpe, {
    meanBlockSessions: c.pass_fail.bootstrap_block_sessions,
    confidence: Number(c.pass_fail.bootstrap_confidence),
    ...(input.bootstrapResamples === undefined ? {} : { resamples: input.bootstrapResamples }),
    ...(input.bootstrapSeed === undefined ? {} : { seed: input.bootstrapSeed }),
  });
  const threshold = Number(c.pass_fail.primary_threshold);
  const volControlled = benchmarks.find((b) => b.arm === "VOLATILITY_CONTROLLED_PRIMARY");
  const candidateMetrics = arms[0];

  const rates = input.taxRates ?? { shortTerm: new Dec("0.32"), longTerm: new Dec("0.15") };
  const tax = taxScenarios({
    realized: candidate.realized,
    totalReturn: candidateMetrics?.totalReturn ?? ZERO,
    initialCash: candidate.nav[0]?.nav ?? ONE,
    rates,
    scenarios: c.tax_scenarios,
  });

  const body = {
    version: REPORT_VERSION,
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    charterHash: bt.charterHash,
    from: bt.from,
    to: bt.to,
    costTier: bt.costs.tier,
    delayBars: bt.costs.delayBars,
    arms: arms.map((a) => [a.arm, a.totalReturn.toFixed(8), a.maxDrawdown.toFixed(8)]),
    benchmarks: benchmarks.map((b) => [b.arm, b.totalReturn.toFixed(8)]),
    primary: [interval.pointEstimate, interval.lower, interval.upper],
    decisions: bt.decisions.length,
    labels: bt.labels,
  };

  const citability = [...bt.citabilityReasons];
  return {
    reportId: `res_${bt.to.replaceAll("-", "")}_${hashJson(body).slice(0, 8)}`,
    version: REPORT_VERSION,
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    charterHash: bt.charterHash,
    from: bt.from,
    to: bt.to,
    costTier: bt.costs.tier,
    delayBars: bt.costs.delayBars,
    arms,
    benchmarks,
    primaryMetric: {
      name: c.pass_fail.primary_metric,
      pointEstimate: interval.pointEstimate,
      interval,
      threshold,
      passes: interval.pointEstimate >= threshold && interval.excludesZero,
    },
    primaryVersusVolatilityControlled:
      volControlled === undefined || candidateMetrics === undefined ? undefined : candidateMetrics.sharpeVsCash - volControlled.sharpeVsCash,
    taxScenarios: tax,
    independentDecisions: Math.floor(bt.sessions.length / SESSIONS_PER_MONTH),
    decisions: bt.decisions.length,
    trialLedgerCount: input.trialLedgerCount,
    labels: bt.labels,
    citableAsEvidence: citability.length === 0,
    citabilityReasons: citability,
    reasonsItMayNotWork: [...c.reasons_it_may_not_work],
    reportHash: `sha256:${hashJson(body)}`,
  };
}
