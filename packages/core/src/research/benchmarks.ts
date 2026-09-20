import { Dec, dec, ONE, ZERO, type IsoDate } from "@blackgold/shared";
import { simpleReturns, TR_ADJUSTMENT_VERSION, type LoadedBar, type TRPoint, type TRSeries } from "../market/series.ts";
import type { RawBar } from "../market/types.ts";

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

export type VolTargetLeg = {
  /** Raw bars, for the open that splits a rebalance session. */
  bars: readonly (RawBar | LoadedBar)[];
  /** The leg's total-return index: the authority for every close-to-close return. */
  tr: TRSeries;
};

export type VolTargetSpec = {
  equity: VolTargetLeg;
  cash: VolTargetLeg;
  /**
   * Session on which a new equity weight takes effect, mapped to that weight. The weight is acquired at that
   * session's OPEN, matching where `simulateFill` acquires the strategy's position.
   */
  activations: ReadonlyMap<IsoDate, Dec>;
};

/**
 * ALPHA_CHARTER section 11 Secondary 2, built as its own index rather than as a weight fed into
 * `blendSeries`.
 *
 * `blendSeries` cannot express this comparator correctly, which four rounds of review established the hard
 * way. It applies one weight to a whole close-to-close return, so a weight acquired at the fill session's
 * open still earns that session's overnight move - a gap the position did not exist for, once per rebalance.
 * It also restricts to sessions common to both legs, so a session missing from either stretches a return
 * interval backwards, potentially across the decision that set the weight.
 *
 * Both follow from the same mismatch, and both disappear here:
 *
 *   - **The rebalance session is split at the open.** The OLD weight earns `prevClose -> open`; the NEW
 *     weight earns `open -> close`. This is exactly how the strategy experiences a fill.
 *   - **The stretch stops mattering.** Whatever interval precedes the open - one session or five - it is
 *     earned by the old weight, which is correct, because the new position did not exist for any of it.
 *
 * Every close-to-close return comes from the legs' total-return indices, so on non-rebalance sessions this is
 * identical to the blend. Only the rebalance session is decomposed, and only there can it differ.
 *
 * The split keeps the session's total return intact: the distribution rides the overnight leg
 * (`(adjOpen + dist) / prevAdjClose`) and the intraday leg carries it through
 * (`(adjClose + dist) / (adjOpen + dist)`), so the two legs multiply back to the index's own
 * `(adjClose + dist) / prevAdjClose`. No return is created or destroyed by decomposing it.
 *
 * Fail-closed: when a rebalance session has no usable open on either leg the split cannot be computed, so the
 * OLD weight earns the whole session and a warning is recorded. That under-credits the new position rather
 * than handing it a move it did not earn.
 */
export function volatilityTargetedSeries(spec: VolTargetSpec): TRSeries {
  const warnings: string[] = [];
  const sessions = commonSessions(spec.equity.tr.points, spec.cash.tr.points);
  const first = sessions[0];
  if (first === undefined) {
    return { entityId: "VOL_TARGET", points: [], adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings: ["no common sessions"] };
  }

  const eqTr = new Map(spec.equity.tr.points.map((p) => [p.session, p]));
  const cashTr = new Map(spec.cash.tr.points.map((p) => [p.session, p]));
  const eqBar = new Map(spec.equity.bars.map((b) => [b.session, b]));
  const cashBar = new Map(spec.cash.bars.map((b) => [b.session, b]));

  const points: TRPoint[] = [{ session: first, trIndex: ONE, adjClose: ONE, distribution: ZERO, terminal: false }];
  let index = ONE;
  // An activation on the very first session needs no split: that session is the index's base point and earns
  // no return, so the weight is simply held into the next one. Without this the loop below, which starts at
  // the second session, would silently ignore it and run the whole series at zero.
  let weight = spec.activations.get(first) ?? ZERO;

  for (let i = 1; i < sessions.length; i++) {
    const session = sessions[i];
    const prev = sessions[i - 1];
    if (session === undefined || prev === undefined) continue;
    const activation = spec.activations.get(session);

    if (activation === undefined || activation.eq(weight)) {
      // No rebalance: one close-to-close step at the current weight, straight from the indices.
      if (activation !== undefined) weight = activation;
      index = index.times(ONE.plus(blendStep(weight, weight, undefined, session, prev, eqTr, cashTr)));
    } else {
      const split = splitAtOpen(session, prev, eqTr, cashTr, eqBar, cashBar);
      if (split === undefined) {
        warnings.push(`no usable open on ${session}; the pre-rebalance weight earned the whole session`);
        index = index.times(ONE.plus(blendStep(weight, weight, undefined, session, prev, eqTr, cashTr)));
      } else {
        index = index.times(ONE.plus(blendStep(weight, activation, split, session, prev, eqTr, cashTr)));
      }
      weight = activation;
    }
    points.push({ session, trIndex: index, adjClose: index, distribution: ZERO, terminal: false });
  }
  return { entityId: "VOL_TARGET", points, adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings };
}

type SessionSplit = { eqOvernight: Dec; eqIntraday: Dec; cashOvernight: Dec; cashIntraday: Dec };

/** One session's blended return, decomposed at the open when `split` is present. */
function blendStep(
  weightBefore: Dec,
  weightAfter: Dec,
  split: SessionSplit | undefined,
  session: IsoDate,
  prev: IsoDate,
  eqTr: ReadonlyMap<string, TRPoint>,
  cashTr: ReadonlyMap<string, TRPoint>,
): Dec {
  if (split === undefined) {
    const eq = closeToClose(eqTr, session, prev);
    const cash = closeToClose(cashTr, session, prev);
    return weightBefore.times(eq).plus(ONE.minus(weightBefore).times(cash));
  }
  const overnight = weightBefore.times(split.eqOvernight).plus(ONE.minus(weightBefore).times(split.cashOvernight));
  const intraday = weightAfter.times(split.eqIntraday).plus(ONE.minus(weightAfter).times(split.cashIntraday));
  return ONE.plus(overnight).times(ONE.plus(intraday)).minus(ONE);
}

function closeToClose(tr: ReadonlyMap<string, TRPoint>, session: IsoDate, prev: IsoDate): Dec {
  const cur = tr.get(session);
  const before = tr.get(prev);
  if (cur === undefined || before?.trIndex.gt(0) !== true) return ZERO;
  return cur.trIndex.div(before.trIndex).minus(ONE);
}

/**
 * Decompose both legs' session return at the open.
 *
 * The index's own step is `(adjClose + dist) / prevAdjClose`. Scaling the raw open by the same split factor
 * the index applied to that session's close (`adjClose / close`) gives a comparable `adjOpen`, and the two
 * pieces are chosen to multiply back to exactly that step. Returns `undefined` when any input is missing or
 * non-positive, so the caller can fall back rather than invent a number.
 */
function splitAtOpen(
  session: IsoDate,
  prev: IsoDate,
  eqTr: ReadonlyMap<string, TRPoint>,
  cashTr: ReadonlyMap<string, TRPoint>,
  eqBar: ReadonlyMap<string, RawBar | LoadedBar>,
  cashBar: ReadonlyMap<string, RawBar | LoadedBar>,
): SessionSplit | undefined {
  const eq = legSplit(eqTr, eqBar, session, prev);
  const cash = legSplit(cashTr, cashBar, session, prev);
  if (eq === undefined || cash === undefined) return undefined;
  return { eqOvernight: eq.overnight, eqIntraday: eq.intraday, cashOvernight: cash.overnight, cashIntraday: cash.intraday };
}

function legSplit(
  tr: ReadonlyMap<string, TRPoint>,
  bars: ReadonlyMap<string, RawBar | LoadedBar>,
  session: IsoDate,
  prev: IsoDate,
): { overnight: Dec; intraday: Dec } | undefined {
  const cur = tr.get(session);
  const before = tr.get(prev);
  const bar = bars.get(session);
  if (cur === undefined || before === undefined || bar === undefined) return undefined;
  if (!before.adjClose.gt(0) || !cur.adjClose.gt(0) || !bar.close.gt(0) || !bar.open.gt(0)) return undefined;
  // The index scaled this session's close by `adjClose / close`; apply the same factor to the open.
  const adjOpen = bar.open.times(cur.adjClose).div(bar.close);
  const openPlusDist = adjOpen.plus(cur.distribution);
  if (!openPlusDist.gt(0)) return undefined;
  return {
    overnight: openPlusDist.div(before.adjClose).minus(ONE),
    intraday: cur.adjClose.plus(cur.distribution).div(openPlusDist).minus(ONE),
  };
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
