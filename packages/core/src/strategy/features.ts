import { addDays, Dec, ONE, ZERO, sumDec, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { ReadOnlyPointInTime } from "../data/pit/types.ts";
import { corporateActionFromValue, corporateActionSourceId, CORPORATE_ACTION_KINDS, type CorporateAction } from "../market/types.ts";
import { RawSeries, TotalReturnSeries, TR_ADJUSTMENT_VERSION, type LoadedBar, type TRPoint } from "../market/series.ts";
import type { Charter } from "./charter.ts";

/**
 * Feature engine for a deterministic charter (ALPHA_CHARTER.md section 6.1).
 *
 * The engine owns its reads. Callers pass a decision instant, never a series: everything is loaded through
 * `PointInTimeRepository.asOf`, so a bar published after the decision cannot enter a feature even if it sits
 * in the same table. Signals come from the total-return series, share quantities and liquidity from the raw
 * series, and the two never mix (docs/DATA_PROVENANCE_SPEC.md section 4).
 *
 * Every value a feature produces is `Dec`. Volatility and covariance are dispersion statistics but they feed
 * position size through inverse-volatility weighting and the volatility-target scale factor, so they are
 * ledger-adjacent: decimal square roots and logs are reproducible across platforms where `Math.sqrt` and
 * `Math.log` are not guaranteed to be in their last bits.
 */

export const FEATURES_VERSION = 1;
const SESSIONS_PER_YEAR = 252;

export type FeatureParams = {
  momentumLookbackSessions: number;
  momentumSkipSessions: number;
  trendSmaSessions: number;
  volatilitySessions: number;
  advSessions: number;
  minAdvUsd: Dec;
};

export function featureParamsFromCharter(c: Charter): FeatureParams {
  return {
    momentumLookbackSessions: c.features.momentum_lookback_sessions,
    momentumSkipSessions: c.features.momentum_skip_sessions,
    trendSmaSessions: c.features.trend_sma_sessions,
    volatilitySessions: c.features.volatility_sessions,
    advSessions: c.features.adv_sessions,
    minAdvUsd: new Dec(c.features.min_adv_usd),
  };
}

/** Sessions of history the longest feature window needs before a decision date can produce features. */
export function requiredHistorySessions(p: FeatureParams): number {
  return Math.max(p.momentumLookbackSessions + 1, p.trendSmaSessions, p.volatilitySessions + 1, p.advSessions);
}

export const INSUFFICIENT_HISTORY = "INSUFFICIENT_HISTORY";
export const NO_BAR_AT_DECISION = "NO_BAR_AT_DECISION";
export const NOT_IN_COVARIANCE_WINDOW = "NOT_IN_COVARIANCE_WINDOW";
/**
 * The entity's newest available bar predates the anchor the rest of the universe reached, so its features
 * would be compared cross-sectionally against fresher prices. Fails closed: the entity is left unpriced.
 */
export const STALE_ANCHOR = "STALE_ANCHOR";

/** Per-entity features at one decision instant. `undefined` fields mean the window could not be formed. */
export type EntityFeatures = {
  entityId: string;
  /** Last session with a bar at or before the decision date. */
  session: IsoDate;
  /** 12-1 style total return over the charter's lookback, skipping the most recent `skip` sessions. */
  mom: Dec | undefined;
  /** True when the adjusted close is above its own simple moving average. */
  trend: boolean | undefined;
  /** Annualized standard deviation of daily log total returns over the covariance window. */
  vol: Dec | undefined;
  /** Average daily dollar volume from raw closes and volumes. */
  adv: Dec | undefined;
  /** Unadjusted close: share quantities, fills, and stop distances only. */
  px: Dec | undefined;
  /** Reasons a field is undefined, plus quality labels carried from the read path. */
  reasons: string[];
  labels: string[];
  /** Observation ids the features were computed from, so a decision record can cite exact rows. */
  observationIds: number[];
};

export type CovarianceWindow = {
  /** Entities in row/column order. */
  entities: string[];
  /** Sessions whose log returns the window covers, ascending. */
  sessions: IsoDate[];
  /** Annualized sample covariance, `entities.length` square, row-major. */
  matrix: Dec[][];
};

export type FeatureSet = {
  decisionAt: UtcInstant;
  /** Last calendar session at or before the decision instant, whether or not its bars have published. */
  decisionSession: IsoDate;
  /**
   * The session every feature is computed at: the newest session for which any universe member has an
   * available bar. When publication lags the decision instant this is the prior session for everyone
   * alike, which is honest. When a single feed is broken it stays current and that member goes STALE_ANCHOR
   * rather than dragging the whole cross-section back to its last good bar.
   */
  anchorSession: IsoDate;
  features: Map<string, EntityFeatures>;
  /** Cash-leg momentum over the same window: the hurdle `mom_i > mom_cash`. */
  cashMom: Dec | undefined;
  cashEntityId: string;
  covariance: CovarianceWindow | undefined;
  /** Union of every read-path label; a run must carry these. */
  labels: string[];
  featuresVersion: number;
  adjustmentVersion: string;
};

export type FeatureEngineDeps = {
  /** Narrowed to the read surface: a feature cannot write an observation. Pass a LeakageAuditor to audit. */
  pit: ReadOnlyPointInTime;
  calendar: ExchangeCalendar;
  barsSourceId?: string;
  snapshotId?: string;
  processingDelayMs?: number;
};

export type ComputeFeaturesInput = {
  riskEntities: readonly string[];
  cashEntityId: string;
  decisionAt: UtcInstant;
  params: FeatureParams;
};

type Loaded = { bars: LoadedBar[]; tr: TRPoint[]; labels: string[]; observationIds: number[]; warnings: string[] };

/** Every corporate-action kind the total-return reconstruction consumes. */
const ACTION_KINDS = CORPORATE_ACTION_KINDS;

function loadEntity(deps: FeatureEngineDeps, entityId: string, from: IsoDate, to: IsoDate, decisionAt: UtcInstant): Loaded {
  const raw = RawSeries.load({
    pit: deps.pit,
    entityId,
    from,
    to,
    decisionAt,
    calendar: deps.calendar,
    ...(deps.barsSourceId === undefined ? {} : { sourceId: deps.barsSourceId }),
    ...(deps.snapshotId === undefined ? {} : { snapshotId: deps.snapshotId }),
    ...(deps.processingDelayMs === undefined ? {} : { processingDelayMs: deps.processingDelayMs }),
  });
  const labels = new Set<string>(raw.labels);
  const actions: CorporateAction[] = [];
  for (const kind of ACTION_KINDS) {
    const res = deps.pit.asOf({
      sourceId: corporateActionSourceId(kind),
      entityId,
      decisionAt,
      ...(deps.snapshotId === undefined ? {} : { snapshotId: deps.snapshotId }),
      ...(deps.processingDelayMs === undefined ? {} : { processingDelayMs: deps.processingDelayMs }),
    });
    for (const l of res.labels) labels.add(l);
    for (const row of res.rows) actions.push(corporateActionFromValue(row.value));
  }
  const tr = TotalReturnSeries.build(raw.bars, actions, entityId);
  return { bars: raw.bars, tr: tr.points, labels: [...labels], observationIds: raw.bars.map((b) => b.observationId), warnings: tr.warnings };
}

/** Index of the last point at or before `session`, or -1. */
function indexAsOf(points: readonly { session: IsoDate }[], session: IsoDate): number {
  let found = -1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p && p.session <= session) found = i;
    else break;
  }
  return found;
}

/** Total return from the point `lookback` sessions back to the point `skip` sessions back. */
function momentum(tr: readonly TRPoint[], i: number, lookback: number, skip: number): Dec | undefined {
  const fromIdx = i - lookback;
  const toIdx = i - skip;
  if (fromIdx < 0 || toIdx < 0) return undefined;
  const from = tr[fromIdx];
  const to = tr[toIdx];
  if (!from || !to || !from.trIndex.gt(0)) return undefined;
  return to.trIndex.div(from.trIndex).minus(ONE);
}

/** Adjusted close above the simple moving average of the trailing `window` adjusted closes (inclusive). */
function trendFlag(tr: readonly TRPoint[], i: number, window: number): boolean | undefined {
  if (i - window + 1 < 0) return undefined;
  const slice = tr.slice(i - window + 1, i + 1);
  if (slice.length !== window) return undefined;
  const cur = tr[i];
  if (!cur) return undefined;
  const sma = sumDec(slice.map((p) => p.adjClose)).div(window);
  return cur.adjClose.gt(sma);
}

/** ln(TR_t / TR_{t-1}) keyed by session, over the whole loaded series. */
function logReturnMap(tr: readonly TRPoint[]): Map<string, Dec> {
  const out = new Map<string, Dec>();
  for (let i = 1; i < tr.length; i++) {
    const prev = tr[i - 1];
    const cur = tr[i];
    if (!prev || !cur) continue;
    if (!prev.trIndex.gt(0) || !cur.trIndex.gt(0)) continue;
    out.set(cur.session, cur.trIndex.div(prev.trIndex).ln());
  }
  return out;
}

/** Mean dollar volume over the trailing `window` raw bars (unadjusted close x volume). */
function averageDollarVolume(bars: readonly LoadedBar[], i: number, window: number): Dec | undefined {
  if (i - window + 1 < 0) return undefined;
  const slice = bars.slice(i - window + 1, i + 1);
  if (slice.length !== window) return undefined;
  return sumDec(slice.map((b) => b.close.times(new Dec(b.volume.toString())))).div(window);
}

/**
 * Annualized sample covariance (n - 1) of daily log returns over `sessions`, for `entities` in order.
 * The diagonal is each entity's variance over the identical window, so `vol_i = sqrt(cov_ii)` by
 * construction and the portfolio volatility `sqrt(w' cov w)` is consistent with the weights it scales.
 */
function covariance(entities: readonly string[], sessions: readonly IsoDate[], returns: ReadonlyMap<string, ReadonlyMap<string, Dec>>): Dec[][] {
  const n = sessions.length;
  if (n < 2) throw new RangeError("covariance needs at least two sessions");
  const series = entities.map((e) => {
    const m = returns.get(e);
    if (!m) throw new RangeError(`no return series for ${e}`);
    return sessions.map((s) => {
      const v = m.get(s);
      if (v === undefined) throw new RangeError(`no return for ${e} on ${s}`);
      return v;
    });
  });
  const means = series.map((xs) => sumDec(xs).div(n));
  const denom = new Dec(n - 1);
  const scale = new Dec(SESSIONS_PER_YEAR);
  const out: Dec[][] = entities.map(() => entities.map(() => ZERO));
  for (let a = 0; a < entities.length; a++) {
    for (let b = a; b < entities.length; b++) {
      const xs = series[a];
      const ys = series[b];
      const mx = means[a];
      const my = means[b];
      if (!xs || !ys || mx === undefined || my === undefined) continue;
      let acc = ZERO;
      for (let t = 0; t < n; t++) {
        const x = xs[t];
        const y = ys[t];
        if (x === undefined || y === undefined) continue;
        acc = acc.plus(x.minus(mx).times(y.minus(my)));
      }
      const cov = acc.div(denom).times(scale);
      const rowA = out[a];
      const rowB = out[b];
      if (rowA) rowA[b] = cov;
      if (rowB) rowB[a] = cov;
    }
  }
  return out;
}

/**
 * Compute every feature the charter's rule table needs at one decision instant.
 *
 * The load window starts `requiredHistorySessions` sessions before the decision session with a generous
 * calendar margin, so a holiday-heavy stretch cannot silently shorten a window: a short window yields
 * `undefined` and an INSUFFICIENT_HISTORY reason, never a value computed from fewer observations.
 */
export function computeFeatures(deps: FeatureEngineDeps, input: ComputeFeaturesInput): FeatureSet {
  const { params } = input;
  if (params.momentumSkipSessions >= params.momentumLookbackSessions) throw new RangeError("momentum skip must be shorter than the lookback");
  const decisionSession = deps.calendar.previousSession(input.decisionAt);
  // Calendar sessions run about 252 a year, so 8/5 calendar days per session plus 30 days of slack is a
  // safe floor. Integer arithmetic only: float literals are banned in this repository.
  const need = requiredHistorySessions(params);
  const from = addDays(decisionSession, -Math.ceil((need * 8) / 5) - 30);

  const entities = [...new Set([...input.riskEntities, input.cashEntityId])];
  const loaded = new Map<string, Loaded>();
  const labels = new Set<string>();
  for (const e of entities) {
    const l = loadEntity(deps, e, from, decisionSession, input.decisionAt);
    loaded.set(e, l);
    for (const lab of l.labels) labels.add(lab);
  }

  // Pass one: the market anchor is the newest session any member has an available bar for.
  let anchorSession: IsoDate | undefined;
  for (const l of loaded.values()) {
    const last = l.bars[l.bars.length - 1]?.session;
    if (last !== undefined && last <= decisionSession && (anchorSession === undefined || last > anchorSession)) anchorSession = last;
  }
  const anchor = anchorSession ?? decisionSession;

  const returns = new Map<string, ReadonlyMap<string, Dec>>();
  const features = new Map<string, EntityFeatures>();

  for (const entityId of input.riskEntities) {
    const l = loaded.get(entityId);
    const reasons: string[] = [];
    const trIdx = l ? indexAsOf(l.tr, anchor) : -1;
    const barIdx = l ? indexAsOf(l.bars, anchor) : -1;
    const barSession = l?.bars[barIdx]?.session;
    const f: EntityFeatures = {
      entityId,
      session: barSession ?? anchor,
      mom: undefined,
      trend: undefined,
      vol: undefined,
      adv: undefined,
      px: undefined,
      reasons,
      labels: l?.labels ?? [],
      observationIds: l?.observationIds ?? [],
    };
    if (!l || trIdx < 0 || barIdx < 0) {
      reasons.push(NO_BAR_AT_DECISION);
      features.set(entityId, f);
      continue;
    }
    if (barSession !== anchor) {
      // Every field stays undefined: an entity priced days behind its peers must not be ranked against them.
      reasons.push(STALE_ANCHOR);
      features.set(entityId, f);
      continue;
    }
    returns.set(entityId, logReturnMap(l.tr));
    f.mom = momentum(l.tr, trIdx, params.momentumLookbackSessions, params.momentumSkipSessions);
    f.trend = trendFlag(l.tr, trIdx, params.trendSmaSessions);
    f.adv = averageDollarVolume(l.bars, barIdx, params.advSessions);
    f.px = l.bars[barIdx]?.close;
    if (f.mom === undefined || f.trend === undefined || f.adv === undefined) reasons.push(INSUFFICIENT_HISTORY);
    features.set(entityId, f);
  }

  // Cash leg: momentum only. It is the hurdle, never a ranked candidate.
  const cash = loaded.get(input.cashEntityId);
  const cashIdx = cash ? indexAsOf(cash.tr, anchor) : -1;
  const cashMom = cash && cashIdx >= 0 ? momentum(cash.tr, cashIdx, params.momentumLookbackSessions, params.momentumSkipSessions) : undefined;
  if (cash && cashIdx >= 0) returns.set(input.cashEntityId, logReturnMap(cash.tr));

  // Covariance window: the last `volatilitySessions` sessions for which every candidate entity has a
  // return. An entity missing from the intersection cannot be sized, so it is marked and left ineligible.
  const covEligible = input.riskEntities.filter((e) => {
    const f = features.get(e);
    return f?.mom !== undefined && f.trend !== undefined && (returns.get(e)?.size ?? 0) >= params.volatilitySessions;
  });
  let covWindow: CovarianceWindow | undefined;
  if (covEligible.length > 0) {
    const first = covEligible[0];
    const firstMap = first === undefined ? undefined : returns.get(first);
    let common = [...(firstMap?.keys() ?? [])].filter((s) => s <= anchor);
    for (const e of covEligible.slice(1)) {
      const m = returns.get(e);
      common = common.filter((s) => m?.has(s) === true);
    }
    common.sort();
    if (common.length >= params.volatilitySessions) {
      const sessions = common.slice(common.length - params.volatilitySessions) as IsoDate[];
      const matrix = covariance(covEligible, sessions, returns);
      covWindow = { entities: [...covEligible], sessions, matrix };
      for (let i = 0; i < covEligible.length; i++) {
        const e = covEligible[i];
        const variance = matrix[i]?.[i];
        const f = e === undefined ? undefined : features.get(e);
        if (f && variance !== undefined) f.vol = variance.gt(0) ? variance.sqrt() : ZERO;
      }
    }
  }
  for (const e of input.riskEntities) {
    const f = features.get(e);
    if (f && f.vol === undefined && !f.reasons.includes(NO_BAR_AT_DECISION) && !f.reasons.includes(STALE_ANCHOR)) f.reasons.push(NOT_IN_COVARIANCE_WINDOW);
  }

  return {
    decisionAt: input.decisionAt,
    decisionSession,
    anchorSession: anchor,
    features,
    cashMom,
    cashEntityId: input.cashEntityId,
    covariance: covWindow,
    labels: [...labels].sort(),
    featuresVersion: FEATURES_VERSION,
    adjustmentVersion: TR_ADJUSTMENT_VERSION,
  };
}

/** Ex-ante annualized portfolio volatility `sqrt(w' cov w)` for weights keyed by entity id. */
export function portfolioVolatility(cov: CovarianceWindow, weights: ReadonlyMap<string, Dec>): Dec {
  let acc = ZERO;
  for (let a = 0; a < cov.entities.length; a++) {
    const ea = cov.entities[a];
    const wa = ea === undefined ? undefined : weights.get(ea);
    if (wa === undefined || wa.isZero()) continue;
    for (let b = 0; b < cov.entities.length; b++) {
      const eb = cov.entities[b];
      const wb = eb === undefined ? undefined : weights.get(eb);
      if (wb === undefined || wb.isZero()) continue;
      const c = cov.matrix[a]?.[b];
      if (c === undefined) continue;
      acc = acc.plus(wa.times(wb).times(c));
    }
  }
  return acc.gt(0) ? acc.sqrt() : ZERO;
}
