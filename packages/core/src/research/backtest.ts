import { Dec, ONE, ZERO, addMs, hashJson, sumDec, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { ReadOnlyPointInTime } from "../data/pit/types.ts";
import { blocksPromotionEvidence } from "../data/quality.ts";
import { RawSeries, TotalReturnSeries, type LoadedBar, type TRPoint, type TRSeries } from "../market/series.ts";
import { actionEffectiveDate, corporateActionFromValue, corporateActionSourceId, CORPORATE_ACTION_KINDS, type CorporateAction } from "../market/types.ts";
import { admittedRiskEtfs, type Charter } from "../strategy/charter.ts";
import { candidateParamsFromCharter, selectCandidates, type CandidateParams, type CandidateSet } from "../strategy/candidates.ts";
import { computeFeatures, featureParamsFromCharter, type FeatureParams } from "../strategy/features.ts";
import { constructTargets, rebalanceOrders, shareTargets, sizingParamsFromCharter, type SizingParams, type TargetWeights } from "../strategy/construct.ts";
import { dailyNavSeries, type PortfolioEvent } from "./nav.ts";
import { simulateFill, type CostModel } from "./simulator.ts";
import type { LeakageAuditor } from "./leakage.ts";

/**
 * Deterministic backtest runner for one registered charter point (PLAN.md Phase 2).
 *
 * The loop is: at each weekly decision instant compute features through `asOf`, apply the charter's rule
 * table, construct targets, seal the decision record, then simulate the resulting orders against RAW bars
 * `execution_delay_bars` sessions later. Two arms run side by side and never see each other, as the protocol
 * requires: `B1_DETERMINISTIC` is the charter, `B0_PASSIVE` is buy-and-hold of the primary benchmark from
 * the same starting cash on the same first executable session.
 *
 * A decision record is written before its own outcome exists. Nothing in the loop reads a later session, and
 * the optional `auditor` re-checks that claim independently on every read.
 *
 * This function computes results. It does NOT register an experiment or open a holdout: the caller must have
 * an approved charter and a registered experiment first. Running it on a DRAFT charter is legitimate and
 * useful (it exercises the machinery on fixtures); citing the numbers as evidence is not, which is why the
 * result carries `registrable` and the labels that bar promotion evidence.
 */

export const BACKTEST_VERSION = 1;
export const COST_MODEL_VERSION = 1;

export type CostTierName = "base" | "adverse" | "stress";

export type ResolvedCosts = {
  tier: string;
  commissionBps: Dec;
  /** Per-symbol half spread in bps, with a `default` fallback. */
  halfSpreadBps: Readonly<Record<string, Dec>>;
  slippageBps: Dec;
  marketImpactBps: Dec;
  delayBars: number;
  maxParticipationOfAdv: Dec;
  costModelVersion: number;
};

export function costsFromCharter(c: Charter, tier: CostTierName, opts: { multiplier?: Dec; delayBarsOverride?: number } = {}): ResolvedCosts {
  const t = c.costs[tier];
  const m = opts.multiplier ?? ONE;
  const halfSpread: Record<string, Dec> = {};
  for (const [k, v] of Object.entries(t.half_spread_bps)) halfSpread[k] = new Dec(v).times(m);
  return {
    tier: m.eq(ONE) ? tier : `${tier}x${m.toFixed()}`,
    commissionBps: new Dec(t.commission_bps).times(m),
    halfSpreadBps: halfSpread,
    slippageBps: new Dec(t.slippage_bps).times(m),
    marketImpactBps: new Dec(t.market_impact_bps).times(m),
    delayBars: opts.delayBarsOverride ?? t.delay_bars,
    maxParticipationOfAdv: new Dec(c.costs.max_participation_of_adv),
    costModelVersion: COST_MODEL_VERSION,
  };
}

/** Half spread plus slippage plus impact for one symbol, as the simulator's flat cost model. */
export function costModelFor(costs: ResolvedCosts, entityId: string): CostModel {
  const half = costs.halfSpreadBps[entityId] ?? costs.halfSpreadBps["default"] ?? ZERO;
  return { commissionBps: costs.commissionBps, halfSpreadBps: half, slippageBps: costs.slippageBps.plus(costs.marketImpactBps) };
}

export type DecisionRecord = {
  decisionAt: UtcInstant;
  decisionSession: IsoDate;
  anchorSession: IsoDate;
  /** NAV the targets were computed against. */
  nav: Dec;
  candidates: CandidateSet;
  targets: TargetWeights;
  /** Whole-share orders the decision produced, before any fill is known. */
  orders: { entityId: string; side: "BUY" | "SELL"; quantity: Dec; reason: string }[];
  /** Hash of the sealed record: computed before any outcome, so a later result cannot alter it. */
  sealHash: string;
  labels: string[];
};

export type ArmResult = {
  arm: "B0_PASSIVE" | "B1_DETERMINISTIC";
  /** Daily NAV marked at raw closes. */
  nav: { session: IsoDate; nav: Dec; cash: Dec; investedWeight: Dec }[];
  /** NAV as a total-return index, for the metric and benchmark engines. */
  index: TRSeries;
  fills: { session: IsoDate; entityId: string; side: "BUY" | "SELL"; quantity: Dec; price: Dec; fees: Dec }[];
  realized: { shortTerm: Dec; longTerm: Dec; total: Dec };
  tradedNotional: Dec;
  /** Cumulative execution shortfall against the decision close, fees included. */
  executionShortfall: Dec;
};

export type BacktestResult = {
  strategyId: string;
  charterVersion: string;
  charterHash: string;
  from: IsoDate;
  to: IsoDate;
  costs: ResolvedCosts;
  decisions: DecisionRecord[];
  arms: Record<string, ArmResult>;
  /** Sessions the run evaluated. */
  sessions: IsoDate[];
  /** Realized equity weight of the deterministic arm per session, for the exposure-matched benchmark. */
  equityWeights: { session: IsoDate; weight: Dec }[];
  /**
   * ALPHA_CHARTER section 11 Secondary 2: the equity weight of "VTI scaled to a 10% ex-ante volatility
   * target with the same 63-day estimator, remainder in BIL", per session.
   *
   * Built to mirror section 9.5 with the holding set reduced to the primary benchmark alone: at each weekly
   * decision the scale factor is `k = min(1, annual_volatility_target / sigma_primary)`, where
   * `sigma_primary` is the primary's annualized volatility from the very `computeFeatures` covariance window
   * the strategy sizes with - the same estimator, not a second implementation of it. The weight takes effect
   * `execution_delay_bars` sessions later, where the strategy's own fills land, and holds until the next
   * decision takes effect. Sessions before the first effective decision carry zero, exactly as the strategy
   * holds no equity before its first fill.
   *
   * Empty when the primary benchmark is not among the charter's risk ETFs, because then `computeFeatures`
   * computes no volatility for it and Secondary 2 cannot be built from the registered estimator. It is left
   * absent rather than approximated - approximating this comparator is what D-51 had to unwind.
   */
  secondary2Weights: { session: IsoDate; weight: Dec }[];
  labels: string[];
  /**
   * Fills that landed on or before the decision that caused them. Must be empty: a non-empty list is a
   * runner defect, not a research finding, and it bars the result from being cited.
   */
  executionOrderViolations: string[];
  /** False when the charter is not registrable, or a label bars promotion evidence. */
  citableAsEvidence: boolean;
  citabilityReasons: string[];
  backtestVersion: number;
  resultHash: string;
};

export type BacktestParams = {
  features: FeatureParams;
  candidates: CandidateParams;
  sizing: SizingParams;
  rebalanceBandPctPoints: Dec;
  decisionOffsetMinutes: number;
  executionDelayBars: number;
};

export function backtestParamsFromCharter(c: Charter): BacktestParams {
  return {
    features: featureParamsFromCharter(c),
    candidates: candidateParamsFromCharter(c),
    sizing: sizingParamsFromCharter(c),
    rebalanceBandPctPoints: new Dec(c.rules.rebalance_band_pct_points),
    decisionOffsetMinutes: c.rules.decision_offset_minutes,
    executionDelayBars: c.rules.execution_delay_bars,
  };
}

export type BacktestInput = {
  charter: Charter;
  charterHash: string;
  pit: ReadOnlyPointInTime;
  calendar: ExchangeCalendar;
  from: IsoDate;
  to: IsoDate;
  initialCash: Dec;
  costs: ResolvedCosts;
  params: BacktestParams;
  /** Passed straight through to the read path; also what the leakage auditor sees. */
  snapshotId?: string;
  processingDelayMs?: number;
  barsSourceId?: string;
  auditor?: LeakageAuditor;
  /** Fraction of feature reads to drop, for the missing-data sensitivity grid. Deterministic, seeded. */
  missingDataRate?: Dec;
  /** Reasons the charter is not registrable, carried into `citabilityReasons`. */
  registrabilityReasons?: readonly string[];
};

/** The last session of each exchange week inside `[from, to]`: the charter's weekly cadence. */
export function weeklyDecisionSessions(calendar: ExchangeCalendar, from: IsoDate, to: IsoDate): IsoDate[] {
  const sessions = calendar.sessionDates(from, to);
  const out: IsoDate[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const cur = sessions[i];
    const next = sessions[i + 1];
    if (cur === undefined) continue;
    if (next === undefined || mondayOf(next) !== mondayOf(cur)) out.push(cur);
  }
  return out;
}

function mondayOf(session: IsoDate): string {
  const d = new Date(`${session}T00:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}

type EntitySeries = { bars: LoadedBar[]; actions: CorporateAction[]; tr: TRSeries; qualityLabels: string[] };

/**
 * Load the execution and marking series.
 *
 * This is deliberately NOT the audited channel. A simulated fill happens one or more sessions after the
 * decision that caused it, and NAV is marked at every session close in the window, so both legitimately read
 * bars dated after a given decision instant. Routing them through the leakage auditor would report every
 * one of them as a backwards read and drown the signal the auditor exists for.
 *
 * The invariant that matters here is a different one, and `runBacktest` checks it directly: no fill may land
 * on a session earlier than the decision that caused it, and none may land on the decision session itself
 * unless the run declared a zero execution delay (which is labelled OPTIMISTIC_DELAY and barred from
 * promotion evidence). Feature reads - the ones a decision is actually made from - go through the auditor.
 */
function loadExecutionSeries(input: BacktestInput, entityId: string, decisionAt: UtcInstant): EntitySeries {
  const pit = input.pit;
  const raw = RawSeries.load({
    pit,
    entityId,
    from: input.from,
    to: input.to,
    decisionAt,
    calendar: input.calendar,
    ...(input.barsSourceId === undefined ? {} : { sourceId: input.barsSourceId }),
    ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
    ...(input.processingDelayMs === undefined ? {} : { processingDelayMs: input.processingDelayMs }),
  });
  const actions: CorporateAction[] = [];
  const qualityLabels = new Set<string>();
  for (const kind of CORPORATE_ACTION_KINDS) {
    const res = pit.asOf({
      sourceId: corporateActionSourceId(kind),
      entityId,
      decisionAt,
      ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
      ...(input.processingDelayMs === undefined ? {} : { processingDelayMs: input.processingDelayMs }),
    });
    // Dedupe by effective date within this (entity, kind). The same event can be present from both the
    // reconciled operator-curated file and the single-source Tiingo feed - different locators, same
    // corporate_action.<kind> source, so asOf retains both. Crediting both would double-count the dividend or
    // split in the total-return series. Keep one action per date, preferring the reconciled row (no
    // UNVERIFIED_SINGLE_SOURCE) over the single-source one; on a tie the later row (greater id) wins.
    const chosen = new Map<string, { id: number; single: boolean; action: CorporateAction }>();
    for (const row of res.rows) {
      // Labeling stays conservative: any single-source action present taints the run even when a reconciled
      // action supersedes it below, so the dedupe can never make a run look more citable than its store does.
      for (const code of blocksPromotionEvidence(row.qualityFlags)) qualityLabels.add(code);
      const action = corporateActionFromValue(row.value);
      const single = row.qualityFlags.includes("UNVERIFIED_SINGLE_SOURCE");
      const key = actionEffectiveDate(action);
      const prev = chosen.get(key);
      if (prev === undefined || (prev.single && !single) || (prev.single === single && row.id > prev.id)) {
        chosen.set(key, { id: row.id, single, action });
      }
    }
    for (const { action } of chosen.values()) actions.push(action);
  }
  return { bars: raw.bars, actions, tr: TotalReturnSeries.build(raw.bars, actions, entityId), qualityLabels: [...qualityLabels] };
}

/**
 * The decision instant at the end of `[from, to]`. NAV marking and simulated fills read series as of this
 * time; it is also the as-of time the benchmark and cash series a result report is built from must use, so
 * those are the same series the run scored against. Mirrors the window-end derivation inside `runBacktest`.
 */
function windowEndDecisionAt(input: BacktestInput): UtcInstant {
  const decisionSessions = weeklyDecisionSessions(input.calendar, input.from, input.to);
  const allSessions = input.calendar.sessionDates(input.from, input.to);
  const decisionAtOf = (session: IsoDate): UtcInstant => addMs(input.calendar.sessionClose(session), input.params.decisionOffsetMinutes * 60_000);
  return decisionSessions.length > 0 ? decisionAtOf(allSessions[allSessions.length - 1] ?? input.to) : decisionAtOf(input.to);
}

/**
 * The charter's primary-benchmark and cash total-return series for a result report, loaded exactly as
 * `runBacktest` marks them: as of the end of the window, through the same point-in-time read path. Kept beside
 * the backtest so a report's benchmarks are the very series the run scored against, never a separately-derived
 * copy that could drift. Promotion-blocking quality flags on a benchmark's own actions still surface through
 * the series' construction, matching `runBacktest`.
 */
export function reportBenchmarkSeries(input: BacktestInput): { primary: TRSeries; cash: TRSeries } {
  const endAt = windowEndDecisionAt(input);
  return {
    primary: loadExecutionSeries(input, input.charter.benchmarks.primary, endAt).tr,
    cash: loadExecutionSeries(input, input.charter.universe.cash_etf, endAt).tr,
  };
}

/**
 * Turn per-decision Secondary 2 scale factors into the per-session equity weight the blend consumes.
 *
 * A decision taken after the close of session `d` cannot change a holding until its orders fill, which the
 * simulator does `execution_delay_bars` sessions later. The weight therefore takes effect at
 * `sessions[index(d) + delayBars]` and holds until the next decision's effective session - the same timing
 * the strategy's own fills obey.
 *
 * Applying the weight at `d` itself would be look-ahead: `blendSeries` multiplies the weight by session `d`'s
 * own return, and the volatility that set the weight was estimated through `d`'s close. Sessions before the
 * first effective decision carry zero, matching a strategy that holds no equity before its first fill.
 *
 * **Known approximation, one session wide.** `simulateFill` fills at the OPEN of the fill session, so the
 * strategy's new position earns only that session's open-to-close move. `blendSeries` works on close-to-close
 * total-return indices, so activating here gives the new weight the whole previous-close-to-close move,
 * including the overnight or weekend gap the strategy's position did not exist for. The error is one gap per
 * rebalance, signed by whichever way gaps run.
 *
 * This is NOT specific to Secondary 2: `EXPOSURE_MATCHED` (Secondary 1) has the identical property, because
 * `dailyNavSeries` measures `investedWeight` at each session's close after applying that session's fills, and
 * `blendSeries` then applies it to the full close-to-close return. Removing it means making the benchmark
 * engine open-aware for both secondaries, which is a wider change than implementing Secondary 2 and is
 * recorded for the owner rather than taken unilaterally
 * (`docs/analysis/2026-09-20-d51-primary-metric.md`).
 */
function secondary2WeightSeries(
  perDecision: readonly { decisionSession: IsoDate; weight: Dec }[],
  allSessions: readonly IsoDate[],
  delayBars: number,
): { session: IsoDate; weight: Dec }[] {
  if (perDecision.length === 0) return [];
  const indexOf = new Map<IsoDate, number>(allSessions.map((s, i) => [s, i]));
  const effective = new Map<number, Dec>();
  for (const { decisionSession, weight } of perDecision) {
    const at = indexOf.get(decisionSession);
    if (at === undefined) continue;
    const target = at + delayBars;
    if (target >= allSessions.length) continue; // decided too late in the window to ever take effect
    // Later decisions win when two map to the same session, matching the order they were taken.
    effective.set(target, weight);
  }
  const out: { session: IsoDate; weight: Dec }[] = [];
  let current = ZERO;
  for (let i = 0; i < allSessions.length; i++) {
    const next = effective.get(i);
    if (next !== undefined) current = next;
    const session = allSessions[i];
    if (session !== undefined) out.push({ session, weight: current });
  }
  return out;
}

function navIndex(entityId: string, nav: readonly { session: IsoDate; nav: Dec }[]): TRSeries {
  const first = nav[0]?.nav;
  const points: TRPoint[] = [];
  if (first?.gt(0) === true) {
    for (const p of nav) {
      const level = p.nav.div(first);
      points.push({ session: p.session, trIndex: level, adjClose: level, distribution: ZERO, terminal: false });
    }
  }
  return { entityId, points, adjustmentVersion: "nav-1.0.0", warnings: [] };
}

/**
 * Run the deterministic arm and the passive arm over `[from, to]`.
 *
 * The two arms hold separate portfolios and separate cash. Neither reads the other's decisions, and the
 * passive arm has no decisions at all: it buys the primary benchmark once, on the first executable session,
 * and holds. That is deliberately the dullest possible comparator, which is the point of `B0_PASSIVE`.
 */
export function runBacktest(input: BacktestInput): BacktestResult {
  const { charter: c, params } = input;
  const cashEtf = c.universe.cash_etf;
  const riskEtfs = admittedRiskEtfs(c);
  const benchmark = c.benchmarks.primary;
  const universe = [...new Set([...riskEtfs, cashEtf, benchmark])];

  const decisionSessions = weeklyDecisionSessions(input.calendar, input.from, input.to);
  const allSessions = input.calendar.sessionDates(input.from, input.to);
  const decisionAtOf = (session: IsoDate): UtcInstant => addMs(input.calendar.sessionClose(session), params.decisionOffsetMinutes * 60_000);

  // Series as of the end of the window: used for marking NAV and for simulated fills, both of which happen
  // strictly after the decision that caused them. Feature reads go through computeFeatures, never through here.
  const endAt = windowEndDecisionAt(input);
  const series = new Map<string, EntitySeries>();
  for (const e of universe) series.set(e, loadExecutionSeries(input, e, endAt));

  const closeOf = (entityId: string, session: IsoDate): Dec | undefined => {
    const bars = series.get(entityId)?.bars;
    if (!bars) return undefined;
    let found: Dec | undefined;
    for (const b of bars) {
      if (b.session <= session) found = b.close;
      else break;
    }
    return found;
  };

  const decisions: DecisionRecord[] = [];
  const events: PortfolioEvent[] = [];
  const fills: ArmResult["fills"] = [];
  const labels = new Set<string>();
  // Promotion-blocking flags on any consumed corporate action (e.g. UNVERIFIED_SINGLE_SOURCE, D-49) enter the
  // run's labels up front, so a run that credits a single-source dividend on any universe entity is barred from
  // promotion evidence even when that entity is not read by the feature engine.
  for (const s of series.values()) for (const l of s.qualityLabels) labels.add(l);
  let tradedNotional = ZERO;
  let shortfall = ZERO;
  const executionOrderViolations: string[] = [];
  let held = new Map<string, Dec>();
  let nav = input.initialCash;
  let cash = input.initialCash;

  const missingRate = input.missingDataRate ?? ZERO;
  let missingCounter = 0;

  // ALPHA_CHARTER section 11 Secondary 2, accumulated per decision and turned into a per-session step
  // function after the loop. Recorded here rather than rebuilt later so the volatility it scales by is the
  // one `computeFeatures` produced at this decision instant, under the same leakage audit as the strategy's.
  const secondary2ByDecision: { decisionSession: IsoDate; weight: Dec }[] = [];

  for (const session of decisionSessions) {
    const decisionAt = decisionAtOf(session);
    const fs = computeFeatures(
      { pit: input.auditor ?? input.pit, calendar: input.calendar, ...(input.barsSourceId === undefined ? {} : { barsSourceId: input.barsSourceId }), ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }), ...(input.processingDelayMs === undefined ? {} : { processingDelayMs: input.processingDelayMs }) },
      { riskEntities: riskEtfs, cashEntityId: cashEtf, decisionAt, params: params.features },
    );
    for (const l of fs.labels) labels.add(l);

    // Secondary 2's scale factor, mirroring section 9.5 with the holding set reduced to the primary alone:
    // k = min(1, target / sigma_primary). sigma_primary is read from the same covariance window the strategy
    // sizes with, so this is the charter's "same 63-day estimator" literally rather than a reimplementation.
    // A missing or zero volatility leaves the weight unscaled at 1, exactly as `constructTargets` does.
    const primaryVol = fs.features.get(benchmark)?.vol;
    if (primaryVol !== undefined) {
      const k = primaryVol.gt(0) ? params.sizing.annualVolatilityTarget.div(primaryVol) : ONE;
      secondary2ByDecision.push({ decisionSession: session, weight: k.lt(ONE) ? k : ONE });
    }

    // Missing-data sensitivity (protocol section 5.8): drop a deterministic share of feature rows and let
    // the charter's own missing-data handling deal with it. Deterministic so the trial reproduces.
    if (missingRate.gt(0)) {
      for (const [entityId, f] of fs.features) {
        missingCounter++;
        if (new Dec(missingCounter % 100).lt(missingRate.times(100))) {
          fs.features.set(entityId, { ...f, mom: undefined, trend: undefined, vol: undefined, reasons: [...f.reasons, "SENSITIVITY_MISSING"] });
        }
      }
      labels.add("SYNTHETIC_MISSING_DATA");
    }

    const candidates = selectCandidates({ features: fs, held: new Set([...held.keys()]), params: params.candidates });

    const vols = new Map<string, Dec>();
    for (const id of candidates.selected) {
      const v = fs.features.get(id)?.vol;
      if (v !== undefined) vols.set(id, v);
    }
    const targets = constructTargets({ selected: candidates.selected, volatilities: vols, covariance: fs.covariance, params: params.sizing });

    // Mark NAV at the decision anchor's raw closes: what the sleeve was worth when the decision was made.
    //
    // Known fidelity limit: this in-loop mark uses the running trade cash and does NOT credit dividends,
    // which are applied in the end-of-run `dailyNavSeries` replay. So the NAV that sizes a position is
    // slightly below the NAV the report shows, by the distributions received so far. The bias is one-directional
    // (it can only make positions smaller, never larger) and small for a 14-ETF universe, but it is a real
    // inconsistency between the decision path and the accounting path. Closing it means running a `Portfolio`
    // inside the loop so fills and dividend credits interleave in date order; that is a runner change, not a
    // charter change, and it is recorded in docs/PHASE2_REQUIREMENTS_MATRIX.md rather than left implicit.
    const prices = new Map<string, Dec>();
    for (const e of universe) {
      const px = closeOf(e, fs.anchorSession);
      if (px !== undefined) prices.set(e, px);
    }
    nav = cash;
    for (const [entityId, qty] of held) nav = nav.plus(qty.times(prices.get(entityId) ?? ZERO));
    if (!nav.gt(0)) break;

    const st = shareTargets({ nav, weights: targets.weights, prices });
    const orders = rebalanceOrders({ nav, targets: st.targets, current: held, prices, bandPctPoints: params.rebalanceBandPctPoints });

    const record: DecisionRecord = {
      decisionAt,
      decisionSession: session,
      anchorSession: fs.anchorSession,
      nav,
      candidates,
      targets,
      orders: orders.map((o) => ({ entityId: o.entityId, side: o.deltaShares.gt(0) ? "BUY" : "SELL", quantity: o.deltaShares.abs(), reason: o.reason })),
      sealHash: "",
      labels: [...labels].sort(),
    };
    // Seal before any fill exists. The hash covers the decision only, never its outcome.
    record.sealHash = `sha256:${hashJson({
      decisionAt,
      anchorSession: fs.anchorSession,
      nav: nav.toFixed(),
      selected: candidates.selected,
      weights: [...targets.weights].map(([k, v]) => [k, v.toFixed()]),
      orders: record.orders.map((o) => [o.entityId, o.side, o.quantity.toFixed(), o.reason]),
    })}`;
    decisions.push(record);

    // Simulate each order against raw bars, `delayBars` sessions after the decision session.
    for (const order of orders) {
      const bars = series.get(order.entityId)?.bars;
      if (!bars || bars.length === 0) continue;
      const side = order.deltaShares.gt(0) ? "BUY" : "SELL";
      const advShares = advCap(series.get(order.entityId)?.bars ?? [], session, params.features.advSessions);
      const participationCapShares = advShares.times(input.costs.maxParticipationOfAdv).floor();
      const wanted = order.deltaShares.abs();
      const quantity = participationCapShares.gt(0) && wanted.gt(participationCapShares) ? participationCapShares : wanted;
      if (!quantity.gt(0)) continue;
      const sim = simulateFill({
        intent: { entityId: order.entityId, side, quantity },
        bars,
        decisionSession: bars.some((b) => b.session === session) ? session : (bars.filter((b) => b.session <= session).at(-1)?.session ?? session),
        delayBars: input.costs.delayBars,
        costs: costModelFor(input.costs, order.entityId),
        maxParticipation: input.costs.maxParticipationOfAdv,
      });
      for (const l of sim.labels) labels.add(l);
      shortfall = shortfall.plus(sim.executionShortfall);
      for (const f of sim.fills) {
        const cost = f.notional.plus(f.fees);
        if (side === "BUY") {
          if (cost.gt(cash)) continue; // cash-funded: an order the cash cannot cover simply does not fill
          cash = cash.minus(cost);
          held.set(order.entityId, (held.get(order.entityId) ?? ZERO).plus(f.quantity));
        } else {
          const have = held.get(order.entityId) ?? ZERO;
          const sell = f.quantity.gt(have) ? have : f.quantity;
          if (!sell.gt(0)) continue;
          cash = cash.plus(f.price.times(sell)).minus(f.fees);
          const left = have.minus(sell);
          if (left.gt(0)) held.set(order.entityId, left);
          else held.delete(order.entityId);
        }
        // A fill may never precede its own decision, and may only land on the decision session itself when
        // the run declared a zero execution delay.
        if (f.session < session || (f.session === session && input.costs.delayBars > 0)) {
          executionOrderViolations.push(`${order.entityId} filled on ${f.session} for the decision of ${session} at delay ${input.costs.delayBars}`);
        }
        tradedNotional = tradedNotional.plus(f.notional);
        fills.push({ session: f.session, entityId: order.entityId, side, quantity: f.quantity, price: f.price, fees: f.fees });
        events.push({ type: "FILL", entityId: order.entityId, side, quantity: f.quantity, price: f.price, fees: f.fees, session: f.session });
      }
    }
    held = new Map([...held].filter(([, q]) => q.gt(0)));
  }

  // Dividends and splits for the deterministic arm's NAV replay.
  for (const [entityId, s] of series) {
    for (const a of s.actions) {
      if (a.kind === "CASH_DIVIDEND") events.push({ type: "DIVIDEND", entityId, amountPerShare: a.amount, payDate: a.payDate });
      if (a.kind === "SPLIT") events.push({ type: "SPLIT", entityId, ratio: a.ratio, exDate: a.exDate });
      if (a.kind === "DELISTING") events.push({ type: "DELISTING", entityId, finalPrice: a.finalPrice, session: a.lastTradeDate });
    }
  }

  const closesAt = (session: IsoDate): Map<string, Dec> => {
    const m = new Map<string, Dec>();
    for (const e of universe) {
      const px = closeOf(e, session);
      if (px !== undefined) m.set(e, px);
    }
    return m;
  };

  const deterministic = dailyNavSeries({ initialCash: input.initialCash, events, sessions: allSessions, closes: closesAt });
  const passive = runPassiveArm(input, series, allSessions, closesAt, benchmark);

  const equityWeights = deterministic.points.map((p) => ({ session: p.session, weight: p.investedWeight }));
  // The RUN's resolved delay, not the charter default: the adverse and stress tiers and `delayBarsOverride`
  // change when the strategy's fills land (`simulateFill` takes `input.costs.delayBars`), and a comparator
  // that shifted by a different number of bars would quietly break the delay-sensitivity test it feeds.
  const secondary2Weights = secondary2WeightSeries(secondary2ByDecision, allSessions, input.costs.delayBars);
  const citability: string[] = [...(input.registrabilityReasons ?? [])];
  for (const l of ["SURVIVORSHIP_BIASED", "OPTIMISTIC_DELAY"]) if (labels.has(l)) citability.push(`run carries the ${l} label`);
  if (labels.has("SYNTHETIC_MISSING_DATA")) citability.push("run injected synthetic missing data for the sensitivity grid");
  if (executionOrderViolations.length > 0) citability.push(`${executionOrderViolations.length} fills landed on or before their own decision session`);

  const arms: Record<string, ArmResult> = {
    B1_DETERMINISTIC: {
      arm: "B1_DETERMINISTIC",
      nav: deterministic.points,
      index: navIndex("B1_DETERMINISTIC", deterministic.points),
      fills,
      realized: deterministic.portfolio.realizedSummary(),
      tradedNotional,
      executionShortfall: shortfall,
    },
    B0_PASSIVE: passive,
  };

  const body = {
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    charterHash: input.charterHash,
    from: input.from,
    to: input.to,
    costsTier: input.costs.tier,
    delayBars: input.costs.delayBars,
    decisionSeals: decisions.map((d) => d.sealHash),
    finalNav: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, (v.nav.at(-1)?.nav ?? ZERO).toFixed()])),
    labels: [...labels].sort(),
  };

  return {
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    charterHash: input.charterHash,
    from: input.from,
    to: input.to,
    costs: input.costs,
    decisions,
    arms,
    sessions: allSessions,
    equityWeights,
    secondary2Weights,
    labels: [...labels].sort(),
    executionOrderViolations,
    citableAsEvidence: citability.length === 0,
    citabilityReasons: citability,
    backtestVersion: BACKTEST_VERSION,
    resultHash: `sha256:${hashJson(body)}`,
  };
}

/** Average daily share volume over the trailing `window` bars at or before `session`. */
function advCap(bars: readonly LoadedBar[], session: IsoDate, window: number): Dec {
  const upTo = bars.filter((b) => b.session <= session);
  const slice = upTo.slice(Math.max(0, upTo.length - window));
  if (slice.length === 0) return ZERO;
  return sumDec(slice.map((b) => new Dec(b.volume.toString()))).div(slice.length);
}

/**
 * `B0_PASSIVE`: buy the primary benchmark on the first executable session and hold. No decisions, no
 * rebalancing, no cash management beyond the whole-share rounding residual.
 */
function runPassiveArm(
  input: BacktestInput,
  series: ReadonlyMap<string, EntitySeries>,
  sessions: readonly IsoDate[],
  closes: (session: IsoDate) => Map<string, Dec>,
  benchmark: string,
): ArmResult {
  const bars = series.get(benchmark)?.bars ?? [];
  const entrySession = sessions[Math.min(input.params.executionDelayBars, Math.max(sessions.length - 1, 0))];
  const entryBar = entrySession === undefined ? undefined : bars.find((b) => b.session >= entrySession && b.tradable);
  const events: PortfolioEvent[] = [];
  const fills: ArmResult["fills"] = [];
  let tradedNotional = ZERO;
  let shortfall = ZERO;

  if (entryBar) {
    const costs = costModelFor(input.costs, benchmark);
    const price = entryBar.open.times(ONE.plus(costs.halfSpreadBps.plus(costs.slippageBps).div(new Dec(10_000))));
    const quantity = input.initialCash.div(price).floor();
    if (quantity.gt(0)) {
      const notional = price.times(quantity);
      const fees = notional.times(costs.commissionBps.div(new Dec(10_000)));
      events.push({ type: "FILL", entityId: benchmark, side: "BUY", quantity, price, fees, session: entryBar.session });
      fills.push({ session: entryBar.session, entityId: benchmark, side: "BUY", quantity, price, fees });
      tradedNotional = notional;
      shortfall = price.minus(entryBar.close).times(quantity).plus(fees);
    }
  }
  for (const a of series.get(benchmark)?.actions ?? []) {
    if (a.kind === "CASH_DIVIDEND") events.push({ type: "DIVIDEND", entityId: benchmark, amountPerShare: a.amount, payDate: a.payDate });
    if (a.kind === "SPLIT") events.push({ type: "SPLIT", entityId: benchmark, ratio: a.ratio, exDate: a.exDate });
  }
  const replay = dailyNavSeries({ initialCash: input.initialCash, events, sessions, closes });
  return {
    arm: "B0_PASSIVE",
    nav: replay.points,
    index: navIndex("B0_PASSIVE", replay.points),
    fills,
    realized: replay.portfolio.realizedSummary(),
    tradedNotional,
    executionShortfall: shortfall,
  };
}
