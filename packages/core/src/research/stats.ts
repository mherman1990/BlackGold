import { Dec, ONE, ZERO, sumDec, hashJson, type IsoDate } from "@blackgold/shared";

/**
 * Research statistics (docs/EXPERIMENT_PROTOCOL.md sections 5.3, 5.6, 5.10).
 *
 * Deliberate split of numeric types. Anything that can reach a position size or a ledger invariant is `Dec`
 * (see market/series.ts and strategy/construct.ts). Everything here is a descriptive statistic on a return
 * series: dispersion, confidence intervals, distribution diagnostics. Those use `number`, matching
 * research/benchmarks.ts, and they can never size a position because nothing downstream reads them.
 *
 * The bootstrap is a stationary block bootstrap with a seeded, explicit generator, so a reported interval is
 * reproducible from the registration record rather than from whatever the platform's RNG happened to do.
 */

export const STATS_VERSION = 1;
const SESSIONS_PER_YEAR = 252;

// ---------------------------------------------------------------------------------------------
// Deterministic pseudo-random numbers
// ---------------------------------------------------------------------------------------------

/**
 * A seeded 32-bit generator (mulberry32). Chosen because it is short enough to read, fast enough for
 * thousands of resamples on a Pi, and deterministic across platforms - the property that matters here.
 * Not cryptographic; nothing security-relevant uses it.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------------------------

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n - 1). Zero for fewer than two observations. */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

/** Sample skewness (Fisher-Pearson, bias-corrected). */
export function skewness(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 0;
  const third = xs.reduce((a, x) => a + ((x - m) / s) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * third;
}

/** Sample excess kurtosis (bias-corrected). Zero for a normal distribution. */
export function excessKurtosis(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 0;
  const fourth = xs.reduce((a, x) => a + ((x - m) / s) ** 4, 0);
  const g2 = (n * (n + 1) * fourth) / ((n - 1) * (n - 2) * (n - 3)) - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return g2;
}

/** Annualized Sharpe ratio of a daily excess-return series. */
export function annualizedSharpe(excess: readonly number[]): number {
  const s = stdev(excess);
  if (s === 0) return 0;
  return (mean(excess) / s) * Math.sqrt(SESSIONS_PER_YEAR);
}

/** Linearly interpolated quantile of a sorted copy of `xs`, with `q` in [0, 1]. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  if (q < 0 || q > 1) throw new RangeError("quantile q must be in [0, 1]");
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo];
  const b = sorted[hi];
  if (a === undefined || b === undefined) return Number.NaN;
  return a + (b - a) * (pos - lo);
}

// ---------------------------------------------------------------------------------------------
// Stationary block bootstrap
// ---------------------------------------------------------------------------------------------

export type BootstrapResult = {
  /** The statistic on the observed series. */
  pointEstimate: number;
  /** Lower and upper bounds at the requested confidence. */
  lower: number;
  upper: number;
  confidence: number;
  resamples: number;
  meanBlockSessions: number;
  seed: number;
  /** True when the interval lies entirely on one side of zero. */
  excludesZero: boolean;
  /** Distribution diagnostics of the input series: the protocol refuses a dressed-up statistic. */
  diagnostics: { n: number; skewness: number; excessKurtosis: number };
  statsVersion: number;
};

/**
 * Stationary block bootstrap (Politis and Romano). Blocks have geometrically distributed lengths with mean
 * `meanBlockSessions` and wrap around the series, which keeps the resampled series stationary and preserves
 * serial dependence at roughly the block scale. The charter freezes the block length (21 sessions, about a
 * month) because momentum windows overlap and an i.i.d. bootstrap would understate the interval.
 */
export function stationaryBootstrap(
  series: readonly number[],
  statistic: (sample: readonly number[]) => number,
  opts: { meanBlockSessions: number; resamples?: number; confidence?: number; seed?: number },
): BootstrapResult {
  const n = series.length;
  if (n < 2) throw new RangeError("bootstrap needs at least two observations");
  if (opts.meanBlockSessions < 1) throw new RangeError("meanBlockSessions must be at least 1");
  const confidence = opts.confidence ?? 0.9;
  if (confidence <= 0 || confidence >= 1) throw new RangeError("confidence must be in (0, 1)");
  const resamples = opts.resamples ?? 2000;
  const seed = opts.seed ?? 1;
  const rand = seededRandom(seed);
  const restartProbability = 1 / opts.meanBlockSessions;

  const stats: number[] = [];
  const sample = new Array<number>(n);
  for (let r = 0; r < resamples; r++) {
    let idx = Math.floor(rand() * n) % n;
    for (let t = 0; t < n; t++) {
      const v = series[idx];
      sample[t] = v ?? 0;
      idx = rand() < restartProbability ? Math.floor(rand() * n) % n : (idx + 1) % n;
    }
    stats.push(statistic(sample));
  }
  const alpha = (1 - confidence) / 2;
  const lower = quantile(stats, alpha);
  const upper = quantile(stats, 1 - alpha);
  return {
    pointEstimate: statistic(series),
    lower,
    upper,
    confidence,
    resamples,
    meanBlockSessions: opts.meanBlockSessions,
    seed,
    excludesZero: (lower > 0 && upper > 0) || (lower < 0 && upper < 0),
    diagnostics: { n, skewness: skewness(series), excessKurtosis: excessKurtosis(series) },
    statsVersion: STATS_VERSION,
  };
}

// ---------------------------------------------------------------------------------------------
// Multiple testing
// ---------------------------------------------------------------------------------------------

export type DeflatedSharpeResult = {
  observedSharpe: number;
  /** Expected maximum Sharpe under the null across `trials` independent trials. */
  expectedMaximumSharpe: number;
  /** Probability the observed Sharpe exceeds the null maximum, adjusted for skew and kurtosis. */
  deflatedSharpe: number;
  trials: number;
  /** False when the protocol's assumption checks fail; the caller must report the raw ledger count instead. */
  assumptionsHold: boolean;
  assumptionNotes: string[];
};

const EULER_MASCHERONI = 0.5772156649015329;
const HALF = 0.5;
const ONE_F = 1;

/** Horner evaluation of a polynomial given highest-order coefficient first. Keeps coefficient tables out
 *  of inline arithmetic, which the repository's float-literal rule forbids and which reads badly anyway. */
function horner(coefficients: readonly number[], x: number): number {
  let acc = 0;
  for (const c of coefficients) acc = acc * x + c;
  return acc;
}

/**
 * Standard normal CDF and quantile.
 *
 * Exported so they are directly testable against published values. `deflatedSharpe` is the only consumer,
 * and a wrong tail here would silently move a multiple-testing verdict, so they are tested on their own
 * rather than only through the statistic that uses them.
 */

/** Abramowitz and Stegun 7.1.26 for erf, |error| < 1.5e-7: far finer than the inputs here warrant. */
const ERF_COEFFICIENTS = [1.061405429, -1.453152027, 1.421413741, -0.284496736, 0.254829592];
const ERF_T_SCALE = 0.3275911;

export function normalCdf(z: number): number {
  const sign = z < 0 ? -ONE_F : ONE_F;
  const x = Math.abs(z) / Math.SQRT2;
  const t = ONE_F / (ONE_F + ERF_T_SCALE * x);
  const erf = ONE_F - horner(ERF_COEFFICIENTS, t) * t * Math.exp(-x * x);
  return HALF * (ONE_F + sign * erf);
}

/** Acklam's rational approximation to the normal quantile, |error| < 1.15e-9. */
const AQ_CENTRAL_NUM = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const AQ_CENTRAL_DEN = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const AQ_TAIL_NUM = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const AQ_TAIL_DEN = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const AQ_TAIL_BOUND = 0.02425;

export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError("normalQuantile p must be in (0, 1)");
  if (p > ONE_F - AQ_TAIL_BOUND) return -normalQuantile(ONE_F - p);
  if (p < AQ_TAIL_BOUND) {
    const q = Math.sqrt(-2 * Math.log(p));
    return horner(AQ_TAIL_NUM, q) / (horner(AQ_TAIL_DEN, q) * q + ONE_F);
  }
  const q = p - HALF;
  const r = q * q;
  return (horner(AQ_CENTRAL_NUM, r) * q) / (horner(AQ_CENTRAL_DEN, r) * r + ONE_F);
}

/**
 * Deflated Sharpe ratio (Bailey and Lopez de Prado). Reported ONLY when its assumptions are supported;
 * otherwise `assumptionsHold` is false and the caller must show the raw trial-ledger count instead
 * (protocol section 5.10: "Never quote a sophisticated statistic to dress up a small sample").
 */
export function deflatedSharpe(input: {
  observedSharpe: number;
  /** Cross-trial standard deviation of the Sharpe estimates. */
  trialSharpeStdev: number;
  trials: number;
  observations: number;
  skewness: number;
  excessKurtosis: number;
}): DeflatedSharpeResult {
  const notes: string[] = [];
  if (input.trials < 2) notes.push("fewer than two trials: the expected maximum under the null is undefined");
  if (input.observations < 60) notes.push(`only ${input.observations} observations: below the 60 the protocol requires for a distributional statistic`);
  if (input.trialSharpeStdev <= 0) notes.push("cross-trial Sharpe dispersion is not positive: the deflation has no scale");
  if (Math.abs(input.excessKurtosis) > 10) notes.push(`excess kurtosis ${input.excessKurtosis.toFixed(2)} is outside the range the adjustment is reliable over`);

  if (notes.length > 0) {
    return { observedSharpe: input.observedSharpe, expectedMaximumSharpe: Number.NaN, deflatedSharpe: Number.NaN, trials: input.trials, assumptionsHold: false, assumptionNotes: notes };
  }

  const n = input.trials;
  const zA = normalQuantile(1 - 1 / n);
  const zB = normalQuantile(1 - 1 / (n * Math.E));
  const expectedMax = input.trialSharpeStdev * ((1 - EULER_MASCHERONI) * zA + EULER_MASCHERONI * zB);

  const t = input.observations;
  const sr = input.observedSharpe / Math.sqrt(SESSIONS_PER_YEAR);
  const srMax = expectedMax / Math.sqrt(SESSIONS_PER_YEAR);
  const denominator = Math.sqrt((1 - input.skewness * sr + ((input.excessKurtosis) / 4) * sr * sr) / (t - 1));
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return {
      observedSharpe: input.observedSharpe,
      expectedMaximumSharpe: expectedMax,
      deflatedSharpe: Number.NaN,
      trials: n,
      assumptionsHold: false,
      assumptionNotes: ["the skew and kurtosis adjustment produced a non-positive variance"],
    };
  }
  return {
    observedSharpe: input.observedSharpe,
    expectedMaximumSharpe: expectedMax,
    deflatedSharpe: normalCdf((sr - srMax) / denominator),
    trials: n,
    assumptionsHold: true,
    assumptionNotes: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Concentration (protocol section 5.6)
// ---------------------------------------------------------------------------------------------

export type ConcentrationInput = {
  /** Cumulative excess return contribution per security. Signed. */
  bySecurity: ReadonlyMap<string, Dec>;
  /** Same, per calendar year. */
  byYear: ReadonlyMap<string, Dec>;
  /** Same, per contiguous episode (a drawdown-to-peak run). */
  byEpisode?: ReadonlyMap<string, Dec>;
};

export type ConcentrationReport = {
  total: Dec;
  /** Share of the total contributed by the top 1, 3 and 5 securities, as decimal fractions. */
  topSecurityShares: { top1: Dec; top3: Dec; top5: Dec };
  topSecurities: string[];
  bestYear: { year: string; share: Dec } | undefined;
  bestEpisode: { episode: string; share: Dec } | undefined;
  /** True when a single security, year or episode carries more than `threshold` of the total. */
  concentrated: boolean;
  threshold: Dec;
};

function topShare(values: ReadonlyMap<string, Dec>, k: number, total: Dec): Dec {
  if (!total.gt(0)) return ZERO;
  const sorted = [...values.values()].sort((a, b) => (b.gt(a) ? 1 : b.lt(a) ? -1 : 0));
  return sumDec(sorted.slice(0, k)).div(total);
}

/**
 * Concentration of cumulative excess return. Only positive totals are meaningful: a strategy that lost to
 * its benchmark has no "share of excess return" to concentrate, so shares are reported as zero and the
 * caller reads the primary metric instead.
 */
export function concentrationReport(input: ConcentrationInput, opts: { threshold?: Dec } = {}): ConcentrationReport {
  const threshold = opts.threshold ?? new Dec("0.40");
  const total = sumDec(input.bySecurity.values());
  const sortedSecurities = [...input.bySecurity].sort((a, b) => (b[1].gt(a[1]) ? 1 : b[1].lt(a[1]) ? -1 : a[0] < b[0] ? -1 : 1));
  const shares = { top1: topShare(input.bySecurity, 1, total), top3: topShare(input.bySecurity, 3, total), top5: topShare(input.bySecurity, 5, total) };

  const best = <T extends string>(m: ReadonlyMap<T, Dec> | undefined): { key: T; share: Dec } | undefined => {
    if (m === undefined || m.size === 0 || !total.gt(0)) return undefined;
    let bestKey: T | undefined;
    let bestVal = ZERO;
    for (const [k, v] of [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (bestKey === undefined || v.gt(bestVal)) {
        bestKey = k;
        bestVal = v;
      }
    }
    return bestKey === undefined ? undefined : { key: bestKey, share: bestVal.div(total) };
  };
  const bestYear = best(input.byYear);
  const bestEpisode = best(input.byEpisode);

  const concentrated =
    shares.top1.gt(threshold) || bestYear?.share.gt(threshold) === true || bestEpisode?.share.gt(threshold) === true;
  return {
    total,
    topSecurityShares: shares,
    topSecurities: sortedSecurities.slice(0, 5).map(([k]) => k),
    bestYear: bestYear === undefined ? undefined : { year: bestYear.key, share: bestYear.share },
    bestEpisode: bestEpisode === undefined ? undefined : { episode: bestEpisode.key, share: bestEpisode.share },
    concentrated,
    threshold,
  };
}

// ---------------------------------------------------------------------------------------------
// Regime labelling (protocol section 5.5)
// ---------------------------------------------------------------------------------------------

export const REGIMES = ["BENCHMARK_DRAWDOWN", "BENCHMARK_RECOVERY", "BENCHMARK_CALM"] as const;
export type Regime = (typeof REGIMES)[number];

/**
 * Preregistered regime classifier: the benchmark's own trailing drawdown state. Computed from the benchmark
 * series alone, so it is knowable at each session and adds no trials to the ledger. Descriptive only.
 */
export function regimeLabels(benchmarkIndex: readonly { session: IsoDate; level: Dec }[], opts: { drawdownThreshold?: Dec } = {}): Map<IsoDate, Regime> {
  const threshold = opts.drawdownThreshold ?? new Dec("0.10");
  const out = new Map<IsoDate, Regime>();
  let peak: Dec | undefined;
  let inDrawdown = false;
  for (const p of benchmarkIndex) {
    if (peak === undefined || p.level.gt(peak)) peak = p.level;
    if (!peak.gt(0)) continue;
    const dd = ONE.minus(p.level.div(peak));
    if (dd.gt(threshold)) inDrawdown = true;
    if (inDrawdown && p.level.gte(peak)) inDrawdown = false;
    out.set(p.session, dd.gt(threshold) ? "BENCHMARK_DRAWDOWN" : inDrawdown ? "BENCHMARK_RECOVERY" : "BENCHMARK_CALM");
  }
  return out;
}

/** Hash a statistics body so a report can be cited exactly. */
export function statsHash(body: unknown): string {
  return `sha256:${hashJson(body)}`;
}
