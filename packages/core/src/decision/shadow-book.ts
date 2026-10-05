import { Dec, ZERO, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { ReadOnlyPointInTime } from "../data/pit/types.ts";
import { loadExecutionSeries, type EntitySeries } from "../research/backtest.ts";
import { dailyNavSeries, type NavPoint, type PortfolioEvent, type Portfolio } from "../research/nav.ts";
import { SHADOW_INITIAL_CASH, type ShadowFillRecord, type ShadowSplit } from "./shadow-fills.ts";
import type { ShadowBookState } from "./shadow-decision.ts";

/**
 * The synthetic shadow book, REPLAYED - never carried as mutable state (D-53 slice 3b). One module so the two
 * shadow jobs cannot disagree about what a book held: the fill job replays it to size each sealed decision's
 * orders, and the decision job replays the same book to know what it holds going into the next decision
 * (candidate hysteresis, the gate's new-risk deltas, and the halt machine's drawdown read it).
 *
 * The replay is the backtest's own accounting: the execution series come from `loadExecutionSeries`, and the
 * book is rebuilt by `dailyNavSeries` from the append-only fill records plus point-in-time corporate actions
 * (splits before same-day fills, dividends on pay date with the EX-DATE entitlement attached). Reads only
 * point-in-time, as of the caller's instant; writes nothing.
 */

export type ShadowDividend = { entityId: string; amountPerShare: Dec; exDate: IsoDate; payDate: IsoDate };

export type ShadowReplayInputs = {
  calendar: ExchangeCalendar;
  /** The first session the replay marks (the first sealed decision's session). */
  firstSession: IsoDate;
  /** Raw execution series per entity, as of the load instant. */
  series: ReadonlyMap<string, EntitySeries>;
  /** Identity, split, and delisting events, as `runBacktest` emits them. Dividends are built per arm. */
  actionEvents: readonly PortfolioEvent[];
  dividends: readonly ShadowDividend[];
  splits: readonly ShadowSplit[];
};

/** Load every series and corporate action the replay needs, through the backtest's own loader, as of `asOf`. */
export function loadShadowReplayInputs(args: {
  pit: ReadOnlyPointInTime;
  calendar: ExchangeCalendar;
  entities: Iterable<string>;
  from: IsoDate;
  to: IsoDate;
  asOf: UtcInstant;
}): ShadowReplayInputs {
  // The default bars source, exactly like the decision job's feature reads (no override is configured).
  const input = { pit: args.pit, calendar: args.calendar, from: args.from, to: args.to };
  const series = new Map<string, EntitySeries>();
  for (const e of [...new Set(args.entities)].sort()) series.set(e, loadExecutionSeries(input, e, args.asOf));

  const actionEvents: PortfolioEvent[] = [];
  const dividends: ShadowDividend[] = [];
  const splits: ShadowSplit[] = [];
  for (const [entityId, es] of series) {
    for (const a of es.actions) {
      if (a.kind === "CASH_DIVIDEND") dividends.push({ entityId, amountPerShare: a.amount, exDate: a.exDate, payDate: a.payDate });
      if (a.kind === "SPLIT") {
        actionEvents.push({ type: "SPLIT", entityId, ratio: a.ratio, exDate: a.exDate });
        splits.push({ entityId, ratio: a.ratio, exDate: a.exDate });
      }
      if (a.kind === "DELISTING") actionEvents.push({ type: "DELISTING", entityId, finalPrice: a.finalPrice, session: a.lastTradeDate });
    }
  }
  return { calendar: args.calendar, firstSession: args.from, series, actionEvents, dividends, splits };
}

/** Raw closes at or before `session` per entity: the mark the replay and the decision sizing both use. */
export function closesAt(inputs: ShadowReplayInputs, session: IsoDate): Map<string, Dec> {
  const m = new Map<string, Dec>();
  for (const [entityId, es] of inputs.series) {
    let found: Dec | undefined;
    for (const b of es.bars) {
      if (b.session <= session) found = b.close;
      else break;
    }
    if (found !== undefined) m.set(entityId, found);
  }
  return m;
}

/**
 * The quantity an arm held going INTO `exDate` (fills and splits strictly before it, splits first on a shared
 * date), which is the dividend-entitled quantity. Passing the pay-date position instead would credit income to
 * shares bought between ex and pay dates and strip it from shares sold there (Codex P1, PR #102) -
 * `dailyNavSeries` only defaults that way when no entitlement is supplied.
 */
function entitledQuantity(inputs: ShadowReplayInputs, fillsForArm: readonly ShadowFillRecord[], entityId: string, exDate: IsoDate): Dec {
  const evs: { date: IsoDate; rank: number; apply: (q: Dec) => Dec }[] = [];
  for (const f of fillsForArm) {
    for (const fill of f.fills) {
      if (fill.entityId !== entityId) continue;
      const qty = new Dec(fill.quantity);
      evs.push({ date: fill.session, rank: 1, apply: (q) => (fill.side === "BUY" ? q.plus(qty) : q.minus(qty)) });
    }
  }
  for (const s of inputs.splits) {
    // A same-date split applies before the fill, matching the replay's own ordering (post-split units).
    if (s.entityId === entityId) evs.push({ date: s.exDate, rank: 0, apply: (q) => q.times(s.ratio) });
  }
  evs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rank - b.rank));
  let q = ZERO;
  for (const e of evs) {
    if (e.date >= exDate) break;
    q = e.apply(q);
  }
  return q;
}

/** Replay one arm's synthetic book from its append-only fill records, marking every session through `toSession`. */
export function replayShadowArm(inputs: ShadowReplayInputs, fillsForArm: readonly ShadowFillRecord[], toSession: IsoDate): { points: NavPoint[]; portfolio: Portfolio } {
  const events: PortfolioEvent[] = [...inputs.actionEvents];
  for (const d of inputs.dividends) {
    events.push({ type: "DIVIDEND", entityId: d.entityId, amountPerShare: d.amountPerShare, payDate: d.payDate, entitledQuantity: entitledQuantity(inputs, fillsForArm, d.entityId, d.exDate) });
  }
  for (const f of fillsForArm) {
    for (const fill of f.fills) {
      events.push({ type: "FILL", entityId: fill.entityId, side: fill.side, quantity: new Dec(fill.quantity), price: new Dec(fill.price), fees: new Dec(fill.fees), session: fill.session });
    }
  }
  const sessions = inputs.calendar.sessionDates(inputs.firstSession, toSession);
  return dailyNavSeries({ initialCash: SHADOW_INITIAL_CASH, events, sessions, closes: (s) => closesAt(inputs, s) });
}

/**
 * The book a decision at `decisionSession` starts from, projected from the arm's replay for the decision path:
 * current weights as fractions of the replayed NAV (keyed by entity id, as the target book is) and the halt
 * machine's portfolio snapshot - NAV at the decision close, the high-water mark over every marked session, and
 * the previous session's NAV as the session-start NAV. All in the synthetic unit; never a real dollar amount.
 *
 * NAV is normalized by {@link SHADOW_INITIAL_CASH} so the snapshot reads as a unit book (1 at inception), the
 * same scale {@link EMPTY_SHADOW_BOOK} uses; the halt machine reads only ratios, so the scale is cosmetic.
 */
export function shadowBookStateAt(replay: { points: readonly NavPoint[]; portfolio: Portfolio }, inputs: ShadowReplayInputs, decisionSession: IsoDate): ShadowBookState {
  const points = replay.points.filter((p) => p.session <= decisionSession);
  const mark = points.at(-1);
  if (!mark?.nav.gt(0)) {
    // No marked session, or a non-positive book: there is no meaningful weight, and the halt machine must read
    // it as an unknown/zero NAV rather than a clean unit book.
    return { currentWeights: new Map(), portfolio: { nav: ZERO, highWaterMark: ZERO, sessionStartNav: ZERO } };
  }
  const prices = closesAt(inputs, decisionSession);
  const currentWeights = new Map<string, Dec>();
  for (const [entityId, pos] of replay.portfolio.positions) {
    if (pos.quantity.isZero()) continue;
    const price = prices.get(entityId);
    // An unpriceable holding cannot be weighted; it is still HELD, so it enters at zero weight rather than
    // vanishing (the gate then treats any positive target for it as an increase, the fail-closed direction).
    currentWeights.set(entityId, price === undefined ? ZERO : pos.quantity.times(price).div(mark.nav));
  }
  const unit = (v: Dec): Dec => v.div(SHADOW_INITIAL_CASH);
  const hwm = points.reduce((acc, p) => (p.nav.gt(acc) ? p.nav : acc), SHADOW_INITIAL_CASH);
  const sessionStart = points.length >= 2 ? (points[points.length - 2]?.nav ?? mark.nav) : SHADOW_INITIAL_CASH;
  return { currentWeights, portfolio: { nav: unit(mark.nav), highWaterMark: unit(hwm), sessionStartNav: unit(sessionStart) } };
}
