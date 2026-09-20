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
 * When a weight was acquired, as an instant on the exchange timeline.
 *
 * Earlier versions expressed this as a mode relative to a landing session ("this weight activates on session
 * X, at its open"). That could not survive a session missing from one leg: the landing session and the
 * session the fill actually happened on came apart, and every attempt to reconcile them by shifting the
 * landing session introduced a different off-by-one. An instant does not have that failure mode - it is the
 * same instant whatever sessions the legs happen to share, and the index places it or declares that it
 * cannot.
 */
export type AcquisitionInstant = { kind: "open" | "close"; session: IsoDate };

export type VolTargetActivation = { weight: Dec; acquiredAt: AcquisitionInstant };

export type VolTargetSpec = {
  equity: VolTargetLeg;
  cash: VolTargetLeg;
  /** Weight changes with the instant each was acquired. Order is irrelevant; the index sorts them. */
  activations: readonly VolTargetActivation[];
  /**
   * The exchange sessions the comparator is supposed to rebalance on - the run's own calendar.
   *
   * Without it, a session BOTH legs lack is invisible: it appears in neither leg's points, so a step that
   * skips it looks like an ordinary consecutive step while actually collapsing two daily rebalances into
   * one. Two stale bars on the same date do exactly that. Sessions either leg observed are always counted,
   * so omitting this still catches the one-leg case.
   */
  expectedSessions?: readonly IsoDate[];
};

export type VolTargetIndex = {
  series: TRSeries;
  /**
   * True only when every activation landed on an instant the index can represent exactly: the close of a
   * session both legs share (the new weight takes the next whole step) or the open of one (the step is
   * split). False the moment any approximation was made.
   *
   * **This is not a cosmetic flag.** Secondary 2 feeds section 16.1's decisive second prong, and an
   * approximation there has no safe direction: under-crediting the comparator makes it easier to beat and
   * over-crediting makes it harder, and which one a given misplacement causes depends on the sign of the
   * weight change and the sign of the move it misassigns. There is no "conservative" way to guess, so the
   * caller must withhold the prong rather than consume a number built this way.
   */
  exact: boolean;
  /** Why `exact` is false, one entry per approximation. Empty when `exact`. */
  inexactReasons: string[];
};

/**
 * Total order on acquisition instants: an open precedes the close of the same session. Exported so every
 * consumer sorts and compares the same way - two definitions of this order is how the previous version's
 * weight path and index came to disagree.
 */
export function instantKey(at: AcquisitionInstant): string {
  return `${at.session}|${at.kind === "open" ? "0" : "1"}`;
}

/**
 * ALPHA_CHARTER section 11 Secondary 2, built as its own index rather than as a weight fed into
 * `blendSeries`.
 *
 * `blendSeries` cannot express this comparator: it applies one weight to a whole close-to-close return, so a
 * weight acquired at a fill would still earn the part of the session that preceded the fill. Here each
 * activation carries the instant its position was acquired, and the index places it against the legs' own
 * return intervals:
 *
 *   - acquired at the CLOSE of a shared session - `execution_delay_bars === 0`, where `simulateFill` fills at
 *     the decision close - the new weight earns the whole of the next step, overnight leg included, and none
 *     of the step ending at that close.
 *   - acquired at the OPEN of a shared session - `execution_delay_bars >= 1` - that step is decomposed: the
 *     old weight earns `prevClose -> open`, the new weight `open -> close`.
 *   - anywhere else - an instant inside a return interval, with no observable price to split it at - the
 *     index says so through `exact: false` instead of guessing.
 *
 * **Distributions stay with the holder that earned them.** On an ex-date the distribution rides the overnight
 * leg only: a buyer at the open has no claim to it. So the pre-open holder earns `(adjOpen + dist) /
 * prevAdjClose` and the new weight the pure price move `adjClose / adjOpen`. These deliberately do NOT
 * multiply back to the index's own `(adjClose + dist) / prevAdjClose` step when the weights differ, and they
 * should not: the portfolio changed composition mid-session, so its return is not a static full-day return.
 * Forcing that identity was an earlier mistake here, and it paid the new weight part of the old holder's
 * dividend.
 *
 * **A stretched interval is reported, not absorbed.** Whatever precedes a split open - one session or five,
 * after a missing or stale bar - is earned by the old weight, which is right, because the new position did
 * not exist for any of it. But an acquisition instant that falls strictly inside such an interval cannot be
 * placed at all, and that is what `exact` exists to say.
 */
export function volatilityTargetedSeries(spec: VolTargetSpec): VolTargetIndex {
  const warnings: string[] = [];
  const inexactReasons: string[] = [];
  const sessions = commonSessions(spec.equity.tr.points, spec.cash.tr.points);
  const first = sessions[0];
  const empty = (reason: string): VolTargetIndex => ({
    series: { entityId: "VOL_TARGET", points: [], adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings: [reason] },
    exact: false,
    inexactReasons: [reason],
  });
  if (first === undefined) return empty("no common sessions");

  for (const a of spec.activations) {
    if (a.weight.isNegative() || a.weight.gt(1)) {
      throw new RangeError(`equity weight ${a.weight.toFixed()} outside [0, 1] at ${a.acquiredAt.kind} of ${a.acquiredAt.session}`);
    }
  }

  const eq = legView(spec.equity);
  const cash = legView(spec.cash);
  const eqTr = eq.tr;
  const cashTr = cash.tr;

  const acts = [...spec.activations].sort((a, b) => {
    const ka = instantKey(a.acquiredAt);
    const kb = instantKey(b.acquiredAt);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Every session the comparator was supposed to rebalance on: the run's calendar where one was supplied,
  // plus anything either leg observed. `commonSessions` silently collapses the rest, and a collapsed step is
  // not the daily-rebalanced quantity section 11 describes. The calendar is what makes a date BOTH legs lack
  // visible - two stale bars on the same session would otherwise leave no trace to detect.
  const unionSessions = [
    ...new Set([
      ...[...spec.equity.tr.points, ...spec.cash.tr.points].map((q) => q.session),
      ...(spec.expectedSessions ?? []),
    ]),
  ].sort();

  const points: TRPoint[] = [{ session: first, trIndex: ONE, adjClose: ONE, distribution: ZERO, terminal: false }];
  let index = ONE;
  let cursor = 0;
  let unionCursor = 0;
  // Anything acquired at or before the base session's close is simply the weight the index opens with: the
  // base session earns no return, so there is nothing for it to be placed against.
  let weight = ZERO;
  for (; cursor < acts.length; cursor++) {
    const a = acts[cursor];
    if (a === undefined || instantKey(a.acquiredAt) > `${first}|1`) break;
    weight = a.weight;
  }

  for (let i = 1; i < sessions.length; i++) {
    const cur = sessions[i];
    const prev = sessions[i - 1];
    if (cur === undefined || prev === undefined) continue;
    const openKey = `${cur}|0`;
    const closeKey = `${cur}|1`;

    // Everything acquired in (close of prev, close of cur]. An instant at cur's close belongs to the NEXT
    // step - it earns none of the step ending at it - so it is held back rather than applied here.
    let atOpen: Dec | undefined;
    let atClose: Dec | undefined;
    // Tracks what is in force as the interval's activations are consumed, so a rebalance that changes nothing
    // is not reported as an approximation: it makes no difference where an unplaceable no-op would have gone.
    let running = weight;
    while (cursor < acts.length) {
      const a = acts[cursor];
      if (a === undefined) break;
      const k = instantKey(a.acquiredAt);
      if (k > closeKey) break;
      if (k === closeKey) {
        atClose = a.weight;
      } else {
        if (k !== openKey && !a.weight.eq(running)) {
          inexactReasons.push(
            `a weight acquired at the ${a.acquiredAt.kind} of ${a.acquiredAt.session} falls inside the ${prev} -> ${cur} return interval, which has no price to split it at`,
          );
        }
        atOpen = a.weight;
      }
      running = a.weight;
      cursor++;
    }

    // A step that skips an expected session collapses several daily rebalances into one. Blending the legs'
    // COMPOUNDED endpoint returns is not the same number as compounding their daily blends: at a 50% weight,
    // +10% then -9.09% against flat cash gives +0.23% daily and 0% collapsed. The data needed to reconstruct
    // the intervening steps is exactly what is missing, so this cannot be repaired here - only reported.
    //
    // Weights of 0 and 1 are exempt: a single-leg blend compounds identically either way. The exemption is
    // tested against the PRE-OPEN weight, never the newly acquired one. The collapsed stretch is everything
    // before this session's open and is priced at the old weight in both branches below, so a rebalance to
    // exactly 1 at the end of a stretched interval would otherwise exempt a collapse that happened entirely
    // at the old fractional weight.
    for (; unionCursor < unionSessions.length; unionCursor++) {
      const u = unionSessions[unionCursor];
      if (u === undefined || u >= cur) break;
    }
    const skipped = unionSessions.slice(0, unionCursor).filter((u) => u > prev);
    if (skipped.length > 0 && !weight.isZero() && !weight.eq(ONE)) {
      inexactReasons.push(
        `the ${prev} -> ${cur} step skips ${String(skipped.length)} session(s) one leg observed, collapsing that many daily rebalances into one`,
      );
    }

    if (atOpen === undefined || atOpen.eq(weight)) {
      index = index.times(ONE.plus(plainStep(weight, cur, prev, eqTr, cashTr)));
      if (atOpen !== undefined) weight = atOpen;
    } else {
      const split = splitAtOpen(eq, cash, cur, prev);
      if (split === undefined) {
        const reason = `no usable open on ${cur}, so the rebalance could not be priced where the fill landed`;
        warnings.push(reason);
        inexactReasons.push(reason);
        index = index.times(ONE.plus(plainStep(weight, cur, prev, eqTr, cashTr)));
      } else {
        // Portfolio value at the open, at the OLD weights, with each leg's income held as cash; then that
        // whole value reallocated at the NEW weights and carried to the close on price alone. These are value
        // factors, so they multiply directly.
        const atOpenValue = weight.times(split.eqOvernight).plus(ONE.minus(weight).times(split.cashOvernight));
        const toClose = atOpen.times(split.eqIntraday).plus(ONE.minus(atOpen).times(split.cashIntraday));
        index = index.times(atOpenValue).times(toClose);
      }
      weight = atOpen;
    }
    if (atClose !== undefined) weight = atClose;
    points.push({ session: cur, trIndex: index, adjClose: index, distribution: ZERO, terminal: false });
  }

  // A rebalance the comparator never reflected is a divergence from the strategy, not a tidy end-of-window
  // detail: the weight the strategy went on holding is not the weight this index held.
  for (; cursor < acts.length; cursor++) {
    const a = acts[cursor];
    if (a === undefined || a.weight.eq(weight)) continue;
    const reason = `a weight acquired at the ${a.acquiredAt.kind} of ${a.acquiredAt.session} falls after the last shared session and was never applied`;
    warnings.push(reason);
    inexactReasons.push(reason);
    weight = a.weight;
  }

  return {
    series: { entityId: "VOL_TARGET", points, adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings },
    exact: inexactReasons.length === 0,
    inexactReasons,
  };
}

/** Both legs' value factors over the two halves of a rebalance session. Factors, not returns. */
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

/** One leg's lookups, plus the cumulative distribution needed to value an interval that spans several. */
type LegView = {
  tr: ReadonlyMap<string, TRPoint>;
  bars: ReadonlyMap<string, RawBar | LoadedBar>;
  /** Sum of every distribution at or before this session, in the index's adjusted share units. */
  cumulativeDistribution: ReadonlyMap<string, Dec>;
};

function legView(leg: VolTargetLeg): LegView {
  let running = ZERO;
  const cumulative = new Map<string, Dec>();
  for (const p of leg.tr.points) {
    running = running.plus(p.distribution);
    cumulative.set(p.session, running);
  }
  return {
    tr: new Map(leg.tr.points.map((p) => [p.session, p])),
    bars: new Map(leg.bars.map((b) => [b.session, b])),
    cumulativeDistribution: cumulative,
  };
}

/**
 * Value one leg over the two halves of a rebalance session, as VALUE FACTORS rather than returns.
 *
 *   overnight = (adjOpen + income) / prevAdjClose   the pre-open holder: price to the open, plus every
 *                                                   distribution that went ex in the interval, as CASH
 *   intraday  =  adjClose / adjOpen                 the open buyer: the price move, and nothing else
 *
 * The raw open is scaled by the factor the index applied to this session's close (`adjClose / close`), so both
 * halves are in the index's share units, and `income` is a difference of cumulative distributions so an
 * ex-date on a session the legs do not share is still counted.
 *
 * **A distribution is cash, not a scaled position.** That is the whole content of this function, and three
 * earlier versions got it wrong in three different ways. Reinvesting it at the open - `(adjClose + d) /
 * (adjOpen + d)` - hands the open buyer income it has no claim to. Deriving the pre-open leg as a residual
 * against the leg's own total-return step puts that income through the new allocation's intraday factor, so a
 * rebalance out of equity on an ex-date is mispriced: at `prevClose 100, open 90, close 100, dist 10` going
 * from weight 1 to 0, the holder sells at 90 and keeps the 10, so the portfolio is flat, and the residual form
 * says -1%. Writing the pre-open leg explicitly but reading only `cur.distribution` silently drops an ex-date
 * on an unshared session.
 *
 * All three follow from trying to express the split as two factors that multiply back to the leg's own step.
 * They cannot: the leg's index reinvests its distribution at the CLOSE, while a portfolio being rebalanced at
 * the open necessarily allocates that cash at the open. The two conventions differ by construction, and only
 * on a session that is both ex-dividend and a rebalance. `volatilityTargetedSeries` documents the consequence.
 */
function legSplit(leg: LegView, session: IsoDate, prev: IsoDate): { overnight: Dec; intraday: Dec } | undefined {
  const cur = leg.tr.get(session);
  const before = leg.tr.get(prev);
  const bar = leg.bars.get(session);
  if (cur === undefined || before === undefined || bar === undefined) return undefined;
  if (!before.adjClose.gt(0) || !cur.adjClose.gt(0) || !bar.close.gt(0) || !bar.open.gt(0)) return undefined;
  const adjOpen = bar.open.times(cur.adjClose).div(bar.close);
  if (!adjOpen.gt(0)) return undefined;
  const income = (leg.cumulativeDistribution.get(session) ?? ZERO).minus(leg.cumulativeDistribution.get(prev) ?? ZERO);
  return { overnight: adjOpen.plus(income).div(before.adjClose), intraday: cur.adjClose.div(adjOpen) };
}

/** Decompose both legs at the open. `undefined` when either leg cannot be split. */
function splitAtOpen(eq: LegView, cash: LegView, session: IsoDate, prev: IsoDate): SessionSplit | undefined {
  const e = legSplit(eq, session, prev);
  const c = legSplit(cash, session, prev);
  if (e === undefined || c === undefined) return undefined;
  return { eqOvernight: e.overnight, eqIntraday: e.intraday, cashOvernight: c.overnight, cashIntraday: c.intraday };
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
