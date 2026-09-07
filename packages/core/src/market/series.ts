import { addDays, Dec, ONE, ZERO, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { ReadOnlyPointInTime } from "../data/pit/types.ts";
import { corporateActionFromValue, corporateActionSourceId, rawBarFromValue, type CorporateAction, type RawBar } from "./types.ts";

/**
 * Two price series, never mixed (docs/DATA_PROVENANCE_SPEC.md section 4).
 *
 * RawSeries: unadjusted bars as printed, read through the point-in-time repository. Drives fills and
 * share quantities. TotalReturnSeries: Black Gold's own split-adjusted, dividend-reinvested index computed
 * from the raw series plus the corporate-action ledger. Drives features and performance. The types differ
 * so a RawBar cannot be handed to a return calculation by accident.
 */

export const TR_ADJUSTMENT_VERSION = "tr-1.0.0";

/** A raw bar plus the load-time quality state a simulator needs. */
export type LoadedBar = RawBar & {
  /** False for a bar the provider repeated (STALE_BAR): kept for continuity, no simulated trade on it. */
  tradable: boolean;
  flags: string[];
  /** Observation row id, so a decision record can cite exactly which bar it used. */
  observationId: number;
};

export type RawSeriesResult = {
  entityId: string;
  sourceId: string;
  bars: LoadedBar[];
  /** Calendar sessions between the first and last loaded bar that have no bar. */
  gaps: IsoDate[];
  /** Labels the caller must carry (OPTIMISTIC_DELAY and so on) plus GAP when gaps exist. */
  labels: string[];
};

export type RawSeriesQuery = {
  pit: ReadOnlyPointInTime;
  entityId: string;
  from: IsoDate;
  to: IsoDate;
  decisionAt: UtcInstant;
  calendar: ExchangeCalendar;
  /** Any `*.bars.1d` source id. */
  sourceId?: string;
  snapshotId?: string;
  processingDelayMs?: number;
};

export const DEFAULT_BARS_SOURCE_ID = "alpaca.iex.bars.1d";

export const RawSeries = {
  /**
   * Bars for one entity with `from <= session <= to`, visible at `decisionAt`, sorted by session. Reads only
   * through `asOf`. A session with a STALE_BAR record (or a bar flagged STALE_BAR) is retained but not tradable.
   */
  load(q: RawSeriesQuery): RawSeriesResult {
    const sourceId = q.sourceId ?? DEFAULT_BARS_SOURCE_ID;
    if (!sourceId.endsWith(".bars.1d")) throw new TypeError(`RawSeries.load expects a *.bars.1d source, got ${sourceId}`);
    const common = {
      decisionAt: q.decisionAt,
      entityId: q.entityId,
      ...(q.snapshotId === undefined ? {} : { snapshotId: q.snapshotId }),
      ...(q.processingDelayMs === undefined ? {} : { processingDelayMs: q.processingDelayMs }),
    };
    const barsRes = q.pit.asOf({ sourceId, ...common });
    const staleRes = q.pit.asOf({ sourceId: corporateActionSourceId("STALE_BAR"), ...common });
    const labels = new Set<string>([...barsRes.labels, ...staleRes.labels]);
    const staleSessions = new Set<string>();
    for (const row of staleRes.rows) {
      const a = corporateActionFromValue(row.value);
      if (a.kind === "STALE_BAR") staleSessions.add(a.session);
    }
    const bySession = new Map<string, LoadedBar>();
    for (const row of barsRes.rows) {
      const bar = rawBarFromValue(row.value, { symbol: q.entityId });
      if (bar.session < q.from || bar.session > q.to) continue;
      const stale = staleSessions.has(bar.session) || row.qualityFlags.includes("STALE_BAR");
      const flags = [...row.qualityFlags];
      if (stale && !flags.includes("STALE_BAR")) flags.push("STALE_BAR");
      // asOf already collapsed corrections per locator; a later row id for the same session wins.
      const prev = bySession.get(bar.session);
      if (prev && prev.observationId > row.id) continue;
      bySession.set(bar.session, { ...bar, tradable: !stale, flags, observationId: row.id });
    }
    const bars = [...bySession.values()].sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
    const gaps: IsoDate[] = [];
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (first && last) {
      for (const s of q.calendar.sessionDates(first.session, last.session)) {
        if (!bySession.has(s)) gaps.push(s);
      }
      if (gaps.length > 0) {
        labels.add("GAP");
        // Flag the first bar after each gap so a feature window can see it crossed missing sessions.
        for (const g of gaps) {
          const next = bars.find((b) => b.session > g);
          if (next && !next.flags.includes("GAP")) next.flags.push("GAP");
        }
      }
    }
    return { entityId: q.entityId, sourceId, bars, gaps, labels: [...labels] };
  },
};

// ---------------------------------------------------------------------------------------------
// Total-return series
// ---------------------------------------------------------------------------------------------

export type TRPoint = {
  session: IsoDate;
  /** Cumulative total-return index, 1 at the first point. */
  trIndex: Dec;
  /** Close in end-of-series share units (all prior prices divided by later split ratios). */
  adjClose: Dec;
  /** Cash-equivalent distribution per adjusted share that went ex on this session (dividend or spun value). */
  distribution: Dec;
  /** True for the synthetic final point that realizes a delisting price (or zero). */
  terminal: boolean;
};

export type TRSeries = {
  entityId: string;
  points: TRPoint[];
  adjustmentVersion: string;
  /** Non-fatal notes: an unvalued spin-off, a split with no bar on its ex-date, and so on. */
  warnings: string[];
};

export class SeriesInputError extends Error {
  constructor(detail: string) {
    super(`Series input error: ${detail}`);
    this.name = "SeriesInputError";
  }
}

export const TotalReturnSeries = {
  /**
   * Build the total-return index from raw closes and corporate actions.
   *
   *   adjClose_t = rawClose_t / prod(ratio of splits with exDate > t)
   *   TR_t = TR_{t-1} * (adjClose_t + dist_t) / adjClose_{t-1}
   *
   * where dist_t is the cash dividend (or spun value = ratio x child first close) going ex on t, scaled into
   * the same share units as adjClose_t. A DELISTING ends the series: bars after lastTradeDate are dropped and
   * a terminal point realizes finalPrice (zero when null). Bars marked STALE_BAR are excluded so the return
   * is computed across the gap. Dec throughout; no number enters the arithmetic.
   */
  build(raw: readonly (RawBar | LoadedBar)[], actions: readonly CorporateAction[], entityId?: string): TRSeries {
    const warnings: string[] = [];
    const id = entityId ?? raw[0]?.symbol ?? "";
    const staleSessions = new Set<string>();
    for (const a of actions) if (a.kind === "STALE_BAR") staleSessions.add(a.session);
    const delisting = actions.find((a) => a.kind === "DELISTING");
    const merger = actions.find((a) => a.kind === "MERGER");
    const endDate = delisting?.kind === "DELISTING" ? delisting.lastTradeDate : merger?.kind === "MERGER" ? addDays(merger.effective, -1) : undefined;

    const bars = [...raw]
      .filter((b) => !staleSessions.has(b.session) && !("tradable" in b && !b.tradable))
      .filter((b) => endDate === undefined || b.session <= endDate)
      .sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
    for (let i = 1; i < bars.length; i++) {
      const cur = bars[i];
      if (cur && bars[i - 1]?.session === cur.session) throw new SeriesInputError(`duplicate session ${cur.session}`);
    }
    const firstBar = bars[0];
    const lastBar = bars[bars.length - 1];
    if (!firstBar || !lastBar) return { entityId: id, points: [], adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings };
    const firstSession = firstBar.session;
    const lastSession = lastBar.session;
    // Cumulative split factor F_t = product of ratios with exDate <= t. adjClose_t = close_t * F_t / F_end.
    const splits = actions
      .filter((a): a is Extract<CorporateAction, { kind: "SPLIT" }> => a.kind === "SPLIT")
      .filter((s) => s.exDate > firstSession && s.exDate <= lastSession)
      .sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
    for (const s of splits) {
      if (!bars.some((b) => b.session === s.exDate)) warnings.push(`SPLIT ${s.exDate} has no bar on its ex-date; applied from the next available bar`);
    }
    let fEnd = ONE;
    for (const s of splits) fEnd = fEnd.times(s.ratio);

    // Distributions keyed by ex-date session, in raw per-share units on that date.
    const rawDist = new Map<string, Dec>();
    const addDist = (session: IsoDate, amount: Dec, label: string): void => {
      if (session <= firstSession) return; // a distribution on/before the first point has no prior close to reinvest against
      const target = bars.find((b) => b.session >= session)?.session;
      if (target === undefined) {
        warnings.push(`${label} on ${session} falls after the last bar; ignored`);
        return;
      }
      if (target !== session) warnings.push(`${label} on ${session} has no bar on its ex-date; applied at ${target}`);
      rawDist.set(target, (rawDist.get(target) ?? ZERO).plus(amount));
    };
    for (const a of actions) {
      if (a.kind === "CASH_DIVIDEND") addDist(a.exDate, a.amount, "CASH_DIVIDEND");
      if (a.kind === "SPINOFF") {
        if (a.childFirstClose === undefined) warnings.push(`SPINOFF ${a.exDate} of ${a.child} has no childFirstClose; spun value not credited`);
        else addDist(a.exDate, a.ratio.times(a.childFirstClose), "SPINOFF");
      }
    }

    const points: TRPoint[] = [];
    let f = ONE;
    let splitIdx = 0;
    let prevAdj: Dec | undefined;
    let tr = ONE;
    for (const bar of bars) {
      while (splitIdx < splits.length && (splits[splitIdx]?.exDate ?? "") <= bar.session) {
        f = f.times(splits[splitIdx]?.ratio ?? ONE);
        splitIdx++;
      }
      const scale = f.div(fEnd);
      const adjClose = bar.close.times(scale);
      const dist = (rawDist.get(bar.session) ?? ZERO).times(scale);
      if (prevAdj !== undefined) {
        if (!prevAdj.gt(0)) throw new SeriesInputError(`non-positive adjusted close before ${bar.session}`);
        tr = tr.times(adjClose.plus(dist)).div(prevAdj);
      }
      points.push({ session: bar.session, trIndex: tr, adjClose, distribution: dist, terminal: false });
      prevAdj = adjClose;
    }

    if (delisting?.kind === "DELISTING" && prevAdj !== undefined) {
      const final = delisting.finalPrice ?? ZERO;
      // finalPrice is in end-of-series share units already (no later split can exist).
      tr = tr.times(final).div(prevAdj);
      points.push({ session: addDays(lastSession, 1), trIndex: tr, adjClose: final, distribution: ZERO, terminal: true });
    } else if (merger?.kind === "MERGER" && prevAdj !== undefined) {
      const cash = merger.terms.cashPerShare ?? ZERO;
      if (merger.terms.stockRatio !== undefined) warnings.push(`MERGER ${merger.effective}: stock consideration not valued in the target's TR series; cash leg only`);
      tr = tr.times(cash).div(prevAdj);
      points.push({ session: merger.effective, trIndex: tr, adjClose: cash, distribution: ZERO, terminal: true });
    }
    return { entityId: id, points, adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings };
  },
};

export type ReturnPoint = { session: IsoDate; value: Dec };

/** r_t = TR_t / TR_{t-1} - 1 for t >= 1. */
export function simpleReturns(points: readonly TRPoint[]): ReturnPoint[] {
  const out: ReturnPoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!prev || !cur) continue;
    if (!prev.trIndex.gt(0)) throw new SeriesInputError(`non-positive index at ${prev.session}`);
    out.push({ session: cur.session, value: cur.trIndex.div(prev.trIndex).minus(ONE) });
  }
  return out;
}

/** ln(TR_t / TR_{t-1}). Throws when the series reaches zero (a total loss has no log return). */
export function logReturns(points: readonly TRPoint[]): ReturnPoint[] {
  const out: ReturnPoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!prev || !cur) continue;
    if (!prev.trIndex.gt(0) || !cur.trIndex.gt(0)) throw new SeriesInputError(`log return undefined at ${cur.session}: index is not positive`);
    out.push({ session: cur.session, value: cur.trIndex.div(prev.trIndex).ln() });
  }
  return out;
}

/** Last point with session <= date, or undefined when the series starts after `date`. */
export function pointAsOf(points: readonly TRPoint[], date: IsoDate): TRPoint | undefined {
  let found: TRPoint | undefined;
  for (const p of points) {
    if (p.session <= date) found = p;
    else break;
  }
  return found;
}

/** Return from the close at (or last before) `from` to the close at (or last before) `to`. */
export function periodReturn(points: readonly TRPoint[], from: IsoDate, to: IsoDate): Dec {
  if (to < from) throw new RangeError(`periodReturn: to ${to} precedes from ${from}`);
  const a = pointAsOf(points, from);
  const b = pointAsOf(points, to);
  if (!a || !b) throw new SeriesInputError(`no series point at or before ${!a ? from : to}`);
  if (!a.trIndex.gt(0)) throw new SeriesInputError(`index is zero at ${a.session}`);
  return b.trIndex.div(a.trIndex).minus(ONE);
}
