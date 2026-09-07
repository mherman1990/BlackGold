import { Dec, dec, ONE, ZERO, type IsoDate } from "@blackgold/shared";
import { simpleReturns, TR_ADJUSTMENT_VERSION, type TRPoint, type TRSeries } from "../market/series.ts";

/**
 * Benchmark engine (docs/EXPERIMENT_PROTOCOL.md section 9 benchmark policy; PLAN.md Phase 1).
 * Series arithmetic (index levels, returns, drawdown, CAGR) is Dec. Dispersion statistics (volatility,
 * Sharpe, information ratio) are `number`: they are descriptive, never a ledger invariant.
 */
export type BlendSpec = {
  equity: TRSeries;
  cash: TRSeries;
  /** Constant weight, or the strategy's realized equity weight held into each session (exposure matching). */
  equityWeight: Dec | ((session: IsoDate) => Dec);
};

export type BenchmarkKind = "VTI_TR" | "SPY_TR" | { blend: BlendSpec };

export type BenchmarkSources = { VTI_TR?: TRSeries; SPY_TR?: TRSeries };

export class BenchmarkUnavailableError extends Error {
  constructor(kind: string) {
    super(`Benchmark series ${kind} was not supplied`);
    this.name = "BenchmarkUnavailableError";
  }
}

export function benchmarkSeries(kind: BenchmarkKind, sources: BenchmarkSources = {}): TRSeries {
  if (typeof kind === "string") {
    const s = sources[kind];
    if (!s) throw new BenchmarkUnavailableError(kind);
    return s;
  }
  return blendSeries(kind.blend);
}

/** Sessions present in both series, ascending. */
export function commonSessions(a: readonly TRPoint[], b: readonly TRPoint[]): IsoDate[] {
  const inB = new Set(b.map((p) => p.session));
  return a.filter((p) => inB.has(p.session)).map((p) => p.session);
}

function restrict(points: readonly TRPoint[], sessions: ReadonlySet<string>): TRPoint[] {
  return points.filter((p) => sessions.has(p.session));
}

/**
 * Daily-rebalanced blend: r_t = w_t r_eq,t + (1 - w_t) r_cash,t with w_t the equity weight held into
 * session t. Index starts at 1 on the first common session.
 */
export function blendSeries(spec: BlendSpec): TRSeries {
  const sessions = commonSessions(spec.equity.points, spec.cash.points);
  const set = new Set<string>(sessions);
  const eq = simpleReturns(restrict(spec.equity.points, set));
  const cash = simpleReturns(restrict(spec.cash.points, set));
  const weightAt = typeof spec.equityWeight === "function" ? spec.equityWeight : (): Dec => spec.equityWeight as Dec;
  const points: TRPoint[] = [];
  const first = sessions[0];
  if (first === undefined) return { entityId: "BLEND", points, adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings: ["no common sessions"] };
  points.push({ session: first, trIndex: ONE, adjClose: ONE, distribution: ZERO, terminal: false });
  let index = ONE;
  for (let i = 0; i < eq.length; i++) {
    const e = eq[i];
    const c = cash[i];
    if (!e || !c) break;
    const w = weightAt(e.session);
    if (w.isNegative() || w.gt(1)) throw new RangeError(`equity weight ${w.toFixed()} outside [0, 1] on ${e.session}`);
    const r = w.times(e.value).plus(ONE.minus(w).times(c.value));
    index = index.times(ONE.plus(r));
    points.push({ session: e.session, trIndex: index, adjClose: index, distribution: ZERO, terminal: false });
  }
  return { entityId: `BLEND(${spec.equity.entityId}/${spec.cash.entityId})`, points, adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

const DAYS_PER_YEAR = new Dec("365.25");
const SESSIONS_PER_YEAR = 252;

function endpoints(points: readonly TRPoint[]): { first: TRPoint; last: TRPoint } {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) throw new RangeError("metric needs at least two points");
  return { first, last };
}

function yearsBetween(from: IsoDate, to: IsoDate): Dec {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  return dec(days).div(DAYS_PER_YEAR);
}

/** (TR_end / TR_start)^(1/years) - 1. A series that ends at zero returns -1. */
export function cagr(points: readonly TRPoint[]): Dec {
  const { first, last } = endpoints(points);
  if (!first.trIndex.gt(0)) throw new RangeError("cagr: starting index must be positive");
  const years = yearsBetween(first.session, last.session);
  if (!years.gt(0)) throw new RangeError("cagr: zero elapsed time");
  if (last.trIndex.isZero()) return ONE.negated();
  return last.trIndex.div(first.trIndex).pow(ONE.div(years)).minus(ONE);
}

/** Most negative peak-to-trough decline of the index, as a non-positive Dec (e.g. "-0.187"). */
export function maxDrawdown(points: readonly TRPoint[]): Dec {
  let peak: Dec | undefined;
  let worst = ZERO;
  for (const p of points) {
    if (peak === undefined || p.trIndex.gt(peak)) peak = p.trIndex;
    if (!peak.gt(0)) continue;
    const dd = p.trIndex.div(peak).minus(ONE);
    if (dd.lt(worst)) worst = dd;
  }
  return worst;
}

function toNumbers(points: readonly TRPoint[]): number[] {
  return simpleReturns(points).map((r) => r.value.toNumber());
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n - 1). */
function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

/** Annualized standard deviation of daily log returns, sqrt(252) scaling. */
export function annualizedVol(points: readonly TRPoint[]): number {
  const logs: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    if (!a.trIndex.gt(0) || !b.trIndex.gt(0)) throw new RangeError(`annualizedVol: index not positive at ${b.session}`);
    logs.push(Math.log(b.trIndex.div(a.trIndex).toNumber()));
  }
  return stdev(logs) * Math.sqrt(SESSIONS_PER_YEAR);
}

/** Paired daily differences of simple returns on common sessions. */
function excessReturns(a: readonly TRPoint[], b: readonly TRPoint[]): number[] {
  const set = new Set<string>(commonSessions(a, b));
  const ra = toNumbers(restrict(a, set));
  const rb = toNumbers(restrict(b, set));
  const out: number[] = [];
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i];
    const y = rb[i];
    if (x !== undefined && y !== undefined) out.push(x - y);
  }
  return out;
}

/** Annualized mean daily excess return over the risk-free series divided by its standard deviation. */
export function sharpe(strategy: readonly TRPoint[], riskFree: readonly TRPoint[]): number {
  const ex = excessReturns(strategy, riskFree);
  const sd = stdev(ex);
  if (sd === 0) return 0;
  return (mean(ex) / sd) * Math.sqrt(SESSIONS_PER_YEAR);
}

/** Annualized mean daily active return over the benchmark divided by tracking error. */
export function informationRatio(strategy: readonly TRPoint[], benchmark: readonly TRPoint[]): number {
  return sharpe(strategy, benchmark);
}

/** Sum of absolute traded notional over average NAV, per year. */
export function annualTurnover(input: { tradedNotional: readonly Dec[]; averageNav: Dec; from: IsoDate; to: IsoDate }): Dec {
  if (!input.averageNav.gt(0)) throw new RangeError("annualTurnover: average NAV must be positive");
  const years = yearsBetween(input.from, input.to);
  if (!years.gt(0)) throw new RangeError("annualTurnover: zero elapsed time");
  let total = ZERO;
  for (const n of input.tradedNotional) total = total.plus(n.abs());
  return total.div(input.averageNav).div(years);
}
