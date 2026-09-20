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

/**
 * Where a new weight was acquired, which decides how its first session is earned.
 *
 *   - `open`         - acquired at this session's OPEN (`execution_delay_bars >= 1`). The session is split:
 *                      the old weight earns `prevClose -> open`, the new weight earns `open -> close`.
 *   - `priorClose`   - acquired at the PREVIOUS session's close (`execution_delay_bars === 0`, where
 *                      `simulateFill` fills at the decision close). The new weight holds the position across
 *                      the whole session, overnight included, so there is nothing to split.
 */
export type VolTargetActivation = { weight: Dec; acquireAt: "open" | "priorClose" };

export type VolTargetSpec = {
  equity: VolTargetLeg;
  cash: VolTargetLeg;
  /** Session on which a new equity weight takes effect, mapped to the weight and how it was acquired. */
  activations: ReadonlyMap<IsoDate, VolTargetActivation>;
};

/**
 * ALPHA_CHARTER section 11 Secondary 2, built as its own index rather than as a weight fed into
 * `blendSeries`.
 *
 * `blendSeries` cannot express this comparator: it applies one weight to a whole close-to-close return, so a
 * weight acquired at a fill would still earn the part of the session that preceded the fill. Here the
 * rebalance session is decomposed at the open instead, which is where `simulateFill` acquires the strategy's
 * position when `execution_delay_bars >= 1`.
 *
 * **Distributions stay with the holder that earned them.** On an ex-date the distribution rides the overnight
 * leg only: a buyer at the open has no claim to it. So the old weight earns `(adjOpen + dist) / prevAdjClose`
 * and the new weight earns the pure price move `adjClose / adjOpen`. These deliberately do NOT multiply back
 * to the index's own `(adjClose + dist) / prevAdjClose` step when the weights differ, and they should not:
 * the portfolio changed composition mid-session, so its return is not a static full-day return. Forcing that
 * identity was an earlier mistake here, and it paid the new weight part of the old holder's dividend.
 *
 * **A stretched interval stops mattering.** Whatever precedes the open - one session or five, after a missing
 * or stale bar - it is earned by the old weight, which is correct, because the new position did not exist for
 * any of it.
 *
 * Only rebalance sessions are decomposed. Everywhere else the index steps by the plain blended close-to-close
 * return taken straight from the legs' total-return indices.
 *
 * Fail-closed twice over: a rebalance session with no usable open is earned entirely at the OLD weight with a
 * warning (under-crediting the new position rather than handing it a move it did not earn), and an activation
 * whose session is absent from the legs' common sessions is carried forward to the next usable one rather
 * than silently dropped - matching `simulateFill`, which skips an untradable bar and fills on the next.
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
  const effective = resolveActivations(spec.activations, sessions, warnings);

  const points: TRPoint[] = [{ session: first, trIndex: ONE, adjClose: ONE, distribution: ZERO, terminal: false }];
  let index = ONE;
  // An activation resolving to the first session needs no split: that session is the base point and earns no
  // return, so the weight is simply held into the next one.
  let weight = effective.get(first)?.weight ?? ZERO;

  for (let i = 1; i < sessions.length; i++) {
    const session = sessions[i];
    const prev = sessions[i - 1];
    if (session === undefined || prev === undefined) continue;
    const activation = effective.get(session);

    if (activation === undefined || activation.weight.eq(weight)) {
      if (activation !== undefined) weight = activation.weight;
      index = index.times(ONE.plus(plainStep(weight, session, prev, eqTr, cashTr)));
    } else if (activation.acquireAt === "priorClose") {
      // Acquired at the previous close: the new weight holds the whole session, overnight included.
      weight = activation.weight;
      index = index.times(ONE.plus(plainStep(weight, session, prev, eqTr, cashTr)));
    } else {
      const split = splitAtOpen(session, prev, eqTr, cashTr, eqBar, cashBar);
      if (split === undefined) {
        warnings.push(`no usable open on ${session}; the pre-rebalance weight earned the whole session`);
        index = index.times(ONE.plus(plainStep(weight, session, prev, eqTr, cashTr)));
      } else {
        const overnight = weight.times(split.eqOvernight).plus(ONE.minus(weight).times(split.cashOvernight));
        const intraday = activation.weight.times(split.eqIntraday).plus(ONE.minus(activation.weight).times(split.cashIntraday));
        index = index.times(ONE.plus(overnight)).times(ONE.plus(intraday));
      }
      weight = activation.weight;
    }
    points.push({ session, trIndex: index, adjClose: index, distribution: ZERO, terminal: false });
  }
  return { entityId: "VOL_TARGET", points, adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings };
}

/**
 * Map each activation onto the session it can actually take effect on.
 *
 * An activation dated to a session the legs do not share - a stale bar dropped from a total-return series, a
 * holiday one leg observes - would otherwise never be consulted, leaving the old weight in force silently.
 * `simulateFill` skips an untradable bar and fills on the next one, so the activation is carried forward the
 * same way, and carried activations acquire at the OPEN of the session they land on.
 */
function resolveActivations(
  activations: ReadonlyMap<IsoDate, VolTargetActivation>,
  sessions: readonly IsoDate[],
  warnings: string[],
): Map<IsoDate, VolTargetActivation> {
  const out = new Map<IsoDate, VolTargetActivation>();
  const ordered = [...activations.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [wanted, act] of ordered) {
    const landing = sessions.find((s) => s >= wanted);
    if (landing === undefined) {
      warnings.push(`activation on ${wanted} falls after the last common session; never applied`);
      continue;
    }
    if (landing !== wanted) {
      warnings.push(`activation on ${wanted} has no common session; carried forward to ${landing}`);
      out.set(landing, { weight: act.weight, acquireAt: "open" });
    } else {
      // A later activation landing on the same session supersedes an earlier one, as the decisions did.
      out.set(landing, act);
    }
  }
  return out;
}

type SessionSplit = { eqOvernight: Dec; eqIntraday: Dec; cashOvernight: Dec; cashIntraday: Dec };

/** One session's blended close-to-close return at a single weight, straight from the legs' indices. */
function plainStep(
  weight: Dec,
  session: IsoDate,
  prev: IsoDate,
  eqTr: ReadonlyMap<string, TRPoint>,
  cashTr: ReadonlyMap<string, TRPoint>,
): Dec {
  const eq = closeToClose(eqTr, session, prev);
  const cash = closeToClose(cashTr, session, prev);
  return weight.times(eq).plus(ONE.minus(weight).times(cash));
}

function closeToClose(tr: ReadonlyMap<string, TRPoint>, session: IsoDate, prev: IsoDate): Dec {
  const cur = tr.get(session);
  const before = tr.get(prev);
  if (cur === undefined || before?.trIndex.gt(0) !== true) return ZERO;
  return cur.trIndex.div(before.trIndex).minus(ONE);
}

/** Decompose both legs' session return at the open. `undefined` when either leg cannot be split. */
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

/**
 * Split one leg's session at the open.
 *
 *   overnight = (adjOpen + dist) / prevAdjClose - 1     the pre-open holder: price move plus the distribution
 *   intraday  =  adjClose / adjOpen - 1                 the open buyer: price only, no claim to the dividend
 *
 * The raw open is scaled by the same factor the index applied to this session's close (`adjClose / close`),
 * so both sides of the split are in the index's share units.
 */
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
  const adjOpen = bar.open.times(cur.adjClose).div(bar.close);
  if (!adjOpen.gt(0)) return undefined;
  return {
    overnight: adjOpen.plus(cur.distribution).div(before.adjClose).minus(ONE),
    intraday: cur.adjClose.div(adjOpen).minus(ONE),
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
