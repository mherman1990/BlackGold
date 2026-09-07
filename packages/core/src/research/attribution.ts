import { Dec, ONE, ZERO, hashJson, type IsoDate } from "@blackgold/shared";
import { commonSessions } from "./benchmarks.ts";
import { simpleReturns, type TRPoint, type TRSeries } from "../market/series.ts";
import { mean, quantile, seededRandom } from "./stats.ts";

/**
 * Benchmark and exposure attribution (docs/EXPERIMENT_PROTOCOL.md sections 5.11 and 10).
 *
 * Two jobs, kept apart because they answer different questions.
 *
 * 1. Cash-timing decomposition. A long-only strategy that holds material cash can beat its equity benchmark
 *    simply by holding less equity through a drawdown. Splitting the excess return into a timing component
 *    (from differing exposure) and a selection component (from holding better equity at the same exposure)
 *    is the difference between "we avoided the market" and "we picked better". The charter's exposure-matched
 *    benchmark exists for exactly this reason, so the split is computed against it, not against VTI.
 *
 * 2. Factor regression. Ordinary least squares of monthly excess returns on named factors, with standard
 *    errors, reported to EXPLAIN rather than to judge. Residual return is the only component the protocol
 *    permits calling candidate alpha, and only when the regression's own diagnostics support it.
 *
 * Statistics here are `number`: descriptive, never a position size. Return aggregation is `Dec`.
 */

export const ATTRIBUTION_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Cash-timing versus selection
// ---------------------------------------------------------------------------------------------

export type ExposureAttribution = {
  /** Total strategy return over the window. */
  strategyReturn: Dec;
  /** Total primary-benchmark return. */
  benchmarkReturn: Dec;
  /** Total exposure-matched blend return: the benchmark held at the strategy's own realized equity weight. */
  exposureMatchedReturn: Dec;
  /** `exposureMatched - benchmark`: what holding less (or more) equity contributed. */
  timingContribution: Dec;
  /** `strategy - exposureMatched`: what holding different equity at the same exposure contributed. */
  selectionContribution: Dec;
  /** `strategy - benchmark`. Equals timing + selection to within compounding cross terms, which are reported. */
  totalExcess: Dec;
  /** The residual from compounding: totalExcess minus (timing + selection). */
  compoundingCrossTerm: Dec;
  averageEquityWeight: Dec;
  sessions: number;
  attributionVersion: number;
};

function totalReturn(points: readonly TRPoint[]): Dec {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || !first.trIndex.gt(0)) return ZERO;
  return last.trIndex.div(first.trIndex).minus(ONE);
}

function restrict(points: readonly TRPoint[], sessions: ReadonlySet<string>): TRPoint[] {
  return points.filter((p) => sessions.has(p.session));
}

/**
 * Split excess return into cash timing and equity selection.
 *
 * `exposureMatched` must be the blend of the primary benchmark and the cash leg at the strategy's realized
 * daily equity weight (research/benchmarks.ts `blendSeries` builds it). The three series are restricted to
 * their common sessions first, so a series that starts late cannot inflate a component.
 */
export function exposureAttribution(input: {
  strategy: TRSeries;
  benchmark: TRSeries;
  exposureMatched: TRSeries;
  /** Realized equity weight held into each session, for the average. */
  equityWeights: readonly { session: IsoDate; weight: Dec }[];
}): ExposureAttribution {
  const ab = new Set(commonSessions(input.strategy.points, input.benchmark.points));
  const common = new Set(commonSessions(restrict(input.strategy.points, ab), input.exposureMatched.points));
  const strategy = restrict(input.strategy.points, common);
  const benchmark = restrict(input.benchmark.points, common);
  const matched = restrict(input.exposureMatched.points, common);

  const sr = totalReturn(strategy);
  const br = totalReturn(benchmark);
  const mr = totalReturn(matched);
  const timing = mr.minus(br);
  const selection = sr.minus(mr);
  const total = sr.minus(br);

  const relevant = input.equityWeights.filter((w) => common.has(w.session));
  const avg = relevant.length === 0 ? ZERO : relevant.reduce((a, w) => a.plus(w.weight), ZERO).div(relevant.length);

  return {
    strategyReturn: sr,
    benchmarkReturn: br,
    exposureMatchedReturn: mr,
    timingContribution: timing,
    selectionContribution: selection,
    totalExcess: total,
    compoundingCrossTerm: total.minus(timing.plus(selection)),
    averageEquityWeight: avg,
    sessions: common.size,
    attributionVersion: ATTRIBUTION_VERSION,
  };
}

// ---------------------------------------------------------------------------------------------
// Ordinary least squares
// ---------------------------------------------------------------------------------------------

export type OlsResult = {
  /** Intercept first, then one coefficient per factor in the order given. */
  coefficients: number[];
  standardErrors: number[];
  tStatistics: number[];
  factorNames: string[];
  rSquared: number;
  adjustedRSquared: number;
  observations: number;
  residuals: number[];
  /** The intercept is the only term the protocol lets anyone call candidate alpha. */
  alpha: number;
  alphaStandardError: number;
  alphaTStatistic: number;
  /**
   * True when the residual sum of squares is negligible against the total: the design fits to machine
   * precision, so the residual variance and
   * every standard error and t statistic are undefined rather than zero. Reported as a flag instead of as
   * `NaN` or `Infinity` so the result stays JSON-serializable and hashable, and so a report says "the fit is
   * degenerate" rather than showing a t of 0, which would read as "not significant".
   */
  degenerateFit: boolean;
};

export class RegressionInputError extends Error {
  constructor(detail: string) {
    super(`Regression input error: ${detail}`);
    this.name = "RegressionInputError";
  }
}

/**
 * Residual-to-total ratio below which a fit is treated as exact. An algebraically perfect fit rarely lands
 * on a residual sum of squares of exactly zero in floating point, so a strict equality test would miss most
 * degenerate fits and report their meaningless zero standard errors as if they were estimates.
 */
const DEGENERATE_FIT_RATIO = 1e-20;

/** Solve a symmetric positive-definite system by Gauss-Jordan with partial pivoting; returns the inverse. */
function invert(matrix: readonly number[][]): number[][] {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]?.[col] ?? 0) > Math.abs(a[pivot]?.[col] ?? 0)) pivot = r;
    }
    const pivotRow = a[pivot];
    const target = a[col];
    if (!pivotRow || !target) throw new RegressionInputError("malformed design matrix");
    if (pivot !== col) {
      a[pivot] = target;
      a[col] = pivotRow;
    }
    const row = a[col];
    const lead = row?.[col];
    if (!row || lead === undefined || Math.abs(lead) < Number.EPSILON) throw new RegressionInputError("design matrix is singular: factors are collinear");
    for (let j = 0; j < 2 * n; j++) row[j] = (row[j] ?? 0) / lead;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const other = a[r];
      const factor = other?.[col];
      if (!other || factor === undefined || factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) other[j] = (other[j] ?? 0) - factor * (row[j] ?? 0);
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * OLS of `y` on an intercept plus `factors`, with homoskedastic standard errors.
 *
 * Requires at least `factors.length + 2` observations, so a regression is never reported from a sample that
 * cannot estimate its own residual variance. Collinear factors throw rather than returning a fitted-looking
 * result from a singular system.
 */
export function ols(y: readonly number[], factors: readonly { name: string; values: readonly number[] }[]): OlsResult {
  const n = y.length;
  const k = factors.length + 1;
  if (n < k + 1) throw new RegressionInputError(`${n} observations cannot estimate ${k} parameters plus a residual variance`);
  for (const f of factors) {
    if (f.values.length !== n) throw new RegressionInputError(`factor ${f.name} has ${f.values.length} observations, expected ${n}`);
  }

  const design: number[][] = [];
  for (let i = 0; i < n; i++) design.push([1, ...factors.map((f) => f.values[i] ?? 0)]);

  const xtx: number[][] = Array.from({ length: k }, () => Array.from({ length: k }, () => 0));
  const xty: number[] = Array.from({ length: k }, () => 0);
  for (let i = 0; i < n; i++) {
    const row = design[i];
    if (!row) continue;
    for (let a = 0; a < k; a++) {
      xty[a] = (xty[a] ?? 0) + (row[a] ?? 0) * (y[i] ?? 0);
      for (let b = 0; b < k; b++) {
        const target = xtx[a];
        if (target) target[b] = (target[b] ?? 0) + (row[a] ?? 0) * (row[b] ?? 0);
      }
    }
  }
  const inverse = invert(xtx);
  const beta = inverse.map((row) => row.reduce((acc, v, j) => acc + v * (xty[j] ?? 0), 0));

  const residuals: number[] = [];
  for (let i = 0; i < n; i++) {
    const row = design[i];
    const fitted = row ? row.reduce((acc, v, j) => acc + v * (beta[j] ?? 0), 0) : 0;
    residuals.push((y[i] ?? 0) - fitted);
  }
  const rss = residuals.reduce((a, r) => a + r * r, 0);
  const yMean = mean(y);
  const tss = y.reduce((a, v) => a + (v - yMean) * (v - yMean), 0);
  const sigmaSquared = rss / (n - k);
  const standardErrors = inverse.map((row, i) => Math.sqrt(Math.max(sigmaSquared * (row[i] ?? 0), 0)));
  const tStatistics = beta.map((b, i) => {
    const se = standardErrors[i] ?? 0;
    return se === 0 ? 0 : b / se;
  });
  const rSquared = tss === 0 ? 0 : 1 - rss / tss;

  return {
    degenerateFit: tss === 0 ? rss === 0 : rss / tss <= DEGENERATE_FIT_RATIO,
    coefficients: beta,
    standardErrors,
    tStatistics,
    factorNames: factors.map((f) => f.name),
    rSquared,
    adjustedRSquared: n - k <= 0 ? 0 : 1 - (1 - rSquared) * ((n - 1) / (n - k)),
    observations: n,
    residuals,
    alpha: beta[0] ?? 0,
    alphaStandardError: standardErrors[0] ?? 0,
    alphaTStatistic: tStatistics[0] ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Monthly aggregation and the reportable attribution bundle
// ---------------------------------------------------------------------------------------------

/** Compound daily simple returns into calendar-month buckets, keyed YYYY-MM, ascending. */
export function monthlyReturns(points: readonly TRPoint[]): { month: string; value: Dec }[] {
  const buckets = new Map<string, Dec>();
  for (const r of simpleReturns(points)) {
    const month = r.session.slice(0, 7);
    buckets.set(month, (buckets.get(month) ?? ONE).times(ONE.plus(r.value)));
  }
  return [...buckets]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, growth]) => ({ month, value: growth.minus(ONE) }));
}

export type FactorAttribution = {
  regression: OlsResult | undefined;
  /** Present when the regression was not run, saying why in the protocol's own terms. */
  notPerformedReason: string | undefined;
  /** Bootstrap interval on the intercept, when a regression exists. */
  alphaInterval: { lower: number; upper: number; confidence: number } | undefined;
  months: number;
  attributionVersion: number;
};

/**
 * Regress monthly excess returns on the supplied factors.
 *
 * Refuses rather than approximates. If fewer than 24 months are available, or a factor series does not
 * cover the same months, the result records that characteristic attribution was not performed, which is what
 * protocol section 10 requires: "If the data are inadequate, the report says characteristic matching was not
 * performed."
 */
export function factorAttribution(input: {
  strategy: TRSeries;
  benchmark: TRSeries;
  /** Monthly factor series keyed YYYY-MM. Missing months disqualify the regression rather than being filled. */
  factors: readonly { name: string; monthly: ReadonlyMap<string, Dec> }[];
  minimumMonths?: number;
  seed?: number;
}): FactorAttribution {
  const minimum = input.minimumMonths ?? 24;
  const strategyMonths = monthlyReturns(input.strategy.points);
  const benchmarkMonths = new Map(monthlyReturns(input.benchmark.points).map((m) => [m.month, m.value]));
  const paired: { month: string; excess: Dec }[] = [];
  for (const m of strategyMonths) {
    const b = benchmarkMonths.get(m.month);
    if (b !== undefined) paired.push({ month: m.month, excess: m.value.minus(b) });
  }

  if (input.factors.length === 0) {
    return { regression: undefined, notPerformedReason: "no factor library was supplied; factor attribution was not performed", alphaInterval: undefined, months: paired.length, attributionVersion: ATTRIBUTION_VERSION };
  }
  const usable = paired.filter((p) => input.factors.every((f) => f.monthly.has(p.month)));
  if (usable.length < minimum) {
    return {
      regression: undefined,
      notPerformedReason: `only ${usable.length} months are covered by every factor series; below the ${minimum} required, so factor attribution was not performed`,
      alphaInterval: undefined,
      months: usable.length,
      attributionVersion: ATTRIBUTION_VERSION,
    };
  }

  const y = usable.map((p) => p.excess.toNumber());
  const factors = input.factors.map((f) => ({ name: f.name, values: usable.map((p) => (f.monthly.get(p.month) ?? ZERO).toNumber()) }));
  let regression: OlsResult;
  try {
    regression = ols(y, factors);
  } catch (e) {
    return {
      regression: undefined,
      notPerformedReason: e instanceof RegressionInputError ? e.message : "regression failed",
      alphaInterval: undefined,
      months: usable.length,
      attributionVersion: ATTRIBUTION_VERSION,
    };
  }

  // A residual bootstrap on the intercept: resample residuals, refit, and read the interval. Seeded, so a
  // reported interval reproduces from the registration record.
  const rand = seededRandom(input.seed ?? 7);
  const alphas: number[] = [];
  const fitted = y.map((v, i) => v - (regression.residuals[i] ?? 0));
  for (let r = 0; r < 1000; r++) {
    const resampled = fitted.map((f) => f + (regression.residuals[Math.floor(rand() * usable.length) % usable.length] ?? 0));
    try {
      alphas.push(ols(resampled, factors).alpha);
    } catch {
      break;
    }
  }
  const confidence = 0.9;
  const alphaInterval = alphas.length === 0 ? undefined : { lower: quantile(alphas, (1 - confidence) / 2), upper: quantile(alphas, 1 - (1 - confidence) / 2), confidence };

  return { regression, notPerformedReason: undefined, alphaInterval, months: usable.length, attributionVersion: ATTRIBUTION_VERSION };
}

/** Hash an attribution bundle so a report can cite it exactly. */
export function attributionHash(body: unknown): string {
  return `sha256:${hashJson(body)}`;
}
