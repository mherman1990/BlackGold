import { Dec, dec, ONE, ZERO, type IsoDate, type Side } from "@blackgold/shared";
import type { RawBar } from "../market/types.ts";

/**
 * Conservative, deterministic fill and cost model for research (PLAN.md Phase 1). It consumes RAW bars
 * only: a fill price is a price a trader could have paid on that date. No randomness; the same inputs
 * always produce the same fills, so a trial's result_hash is reproducible.
 *
 * Rules: a decision made at the close of `decisionSession` fills at the OPEN `delayBars` sessions later,
 * adverse by (halfSpread + slippage) bps for the side, capped at `maxParticipation` of that bar's volume
 * in whole shares, with the remainder carried forward for up to `maxFillBars` bars. A STALE_BAR bar
 * (tradable === false) is skipped: no simulated trade on a bar the provider repeated. Commission is
 * `notional x commissionBps`. `delayBars = 0` fills at the decision close itself and is labelled
 * OPTIMISTIC_DELAY (protocol delay-sensitivity grids include 0; promotion evidence never does).
 */
export type SimBar = RawBar & { tradable?: boolean };

export type SimIntent = { entityId: string; side: Side; quantity: Dec };

/** Basis points as decimals: "2" means 2 bps. */
export type CostModel = { commissionBps: Dec; halfSpreadBps: Dec; slippageBps: Dec };

export type SimulateFillInput = {
  intent: SimIntent;
  /** Session-ordered raw bars for the intent's entity. */
  bars: readonly SimBar[];
  decisionSession: IsoDate;
  /** Sessions between decision and first fill attempt. Default 1. */
  delayBars?: number;
  costs: CostModel;
  /** Fraction of a bar's volume the order may consume. Default "0.02". */
  maxParticipation?: Dec;
  /** Bars to keep working the remainder. Default 5. */
  maxFillBars?: number;
};

export type SimFill = {
  session: IsoDate;
  quantity: Dec;
  /** Executed price after the adverse spread and slippage adjustment. */
  price: Dec;
  /** The bar price the fill was derived from (open, or the decision close when delayBars = 0). */
  referencePrice: Dec;
  notional: Dec;
  fees: Dec;
};

export type SimulateFillResult = {
  fills: SimFill[];
  filledQuantity: Dec;
  unfilledQuantity: Dec;
  decisionClose: Dec;
  /** Signed cost versus the decision close, fees included; positive is worse for the trader. */
  executionShortfall: Dec;
  /** Shortfall as bps of decision-close notional of the filled quantity (zero when nothing filled). */
  executionShortfallBps: Dec;
  skippedSessions: IsoDate[];
  labels: string[];
};

export class DecisionSessionNotFoundError extends Error {
  constructor(session: IsoDate) {
    super(`No bar for decision session ${session}`);
    this.name = "DecisionSessionNotFoundError";
  }
}

const TEN_THOUSAND = dec(10_000);
export const DEFAULT_MAX_PARTICIPATION: Dec = new Dec("0.02");
export const DEFAULT_DELAY_BARS = 1;
export const DEFAULT_MAX_FILL_BARS = 5;

function assertBps(v: Dec, label: string): void {
  if (v.isNegative()) throw new RangeError(`${label} must be non-negative`);
}

export function simulateFill(input: SimulateFillInput): SimulateFillResult {
  const { intent, bars, costs } = input;
  const delayBars = input.delayBars ?? DEFAULT_DELAY_BARS;
  const maxFillBars = input.maxFillBars ?? DEFAULT_MAX_FILL_BARS;
  const participation = input.maxParticipation ?? DEFAULT_MAX_PARTICIPATION;
  if (!Number.isInteger(delayBars) || delayBars < 0) throw new RangeError("delayBars must be a non-negative integer");
  if (!Number.isInteger(maxFillBars) || maxFillBars < 1) throw new RangeError("maxFillBars must be a positive integer");
  if (!participation.gt(0) || participation.gt(1)) throw new RangeError("maxParticipation must be in (0, 1]");
  if (!intent.quantity.gt(0)) throw new RangeError("intent quantity must be positive");
  assertBps(costs.commissionBps, "commissionBps");
  assertBps(costs.halfSpreadBps, "halfSpreadBps");
  assertBps(costs.slippageBps, "slippageBps");
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1];
    const b = bars[i];
    if (a && b && a.session >= b.session) throw new RangeError(`bars must be strictly session-ordered (${a.session} then ${b.session})`);
  }

  const decisionIdx = bars.findIndex((b) => b.session === input.decisionSession);
  const decisionBar = bars[decisionIdx];
  if (decisionIdx < 0 || !decisionBar) throw new DecisionSessionNotFoundError(input.decisionSession);
  const decisionClose = decisionBar.close;

  const sign = intent.side === "BUY" ? ONE : ONE.negated();
  const adverseFactor = ONE.plus(sign.times(costs.halfSpreadBps.plus(costs.slippageBps)).div(TEN_THOUSAND));
  const commissionRate = costs.commissionBps.div(TEN_THOUSAND);

  const fills: SimFill[] = [];
  const skipped: IsoDate[] = [];
  const labels: string[] = [];
  let remaining = intent.quantity;

  if (delayBars === 0) {
    // Fill at the decision close: the frictionless-timing assumption, labelled so it can never be promotion evidence.
    labels.push("OPTIMISTIC_DELAY");
    if (decisionBar.tradable !== false) {
      const cap = participationCap(decisionBar.volume, participation);
      const qty = remaining.lt(cap) ? remaining : cap;
      if (qty.gt(0)) {
        fills.push(makeFill(decisionBar.session, qty, decisionClose, adverseFactor, commissionRate));
        remaining = remaining.minus(qty);
      }
    } else {
      skipped.push(decisionBar.session);
    }
  }

  const start = decisionIdx + Math.max(delayBars, 1);
  for (let i = start; i < bars.length && remaining.gt(0) && i < start + maxFillBars; i++) {
    if (delayBars === 0 && i === start && fills.length > 0 && remaining.isZero()) break;
    const bar = bars[i];
    if (!bar) break;
    if (bar.tradable === false) {
      skipped.push(bar.session);
      continue;
    }
    const cap = participationCap(bar.volume, participation);
    const qty = remaining.lt(cap) ? remaining : cap;
    if (!qty.gt(0)) continue;
    fills.push(makeFill(bar.session, qty, bar.open, adverseFactor, commissionRate));
    remaining = remaining.minus(qty);
  }

  let filled = ZERO;
  let shortfall = ZERO;
  for (const f of fills) {
    filled = filled.plus(f.quantity);
    shortfall = shortfall.plus(sign.times(f.price.minus(decisionClose)).times(f.quantity)).plus(f.fees);
  }
  const decisionNotional = decisionClose.times(filled);
  const shortfallBps = decisionNotional.gt(0) ? shortfall.div(decisionNotional).times(TEN_THOUSAND) : ZERO;
  return {
    fills,
    filledQuantity: filled,
    unfilledQuantity: remaining,
    decisionClose,
    executionShortfall: shortfall,
    executionShortfallBps: shortfallBps,
    skippedSessions: skipped,
    labels,
  };
}

/** Whole shares: floor(volume x participation). */
export function participationCap(volume: bigint, participation: Dec): Dec {
  return dec(volume).times(participation).floor();
}

function makeFill(session: IsoDate, quantity: Dec, referencePrice: Dec, adverseFactor: Dec, commissionRate: Dec): SimFill {
  const price = referencePrice.times(adverseFactor);
  const notional = price.times(quantity);
  return { session, quantity, price, referencePrice, notional, fees: notional.times(commissionRate) };
}
