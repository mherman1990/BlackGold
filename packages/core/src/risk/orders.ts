import { Dec, ZERO, sumDec } from "@blackgold/shared";
import type { RiskConfig } from "../config/schema.ts";
import type { Charter } from "../strategy/charter.ts";
import type { LimitViolation, RiskVerdict } from "./limits.ts";
import { instrumentLiquidityViolations } from "./liquidity.ts";

/**
 * The deterministic order-level guard (docs/PRODUCT_SPEC.md section 8, `risk.yaml` `orderLimits` and the
 * order-time half of `liquidity`; the follow-up D-45 deferred, D-55).
 *
 * A PREDICATE over one session's proposed orders: it names every breach with a reason code and never re-sizes,
 * splits, or drops an order. The charter (ALPHA_CHARTER.md section 10) says an order over a size cap "is split
 * across sessions or rejected; it is never enlarged" - deciding between those is the consumer's job (a future
 * slicer, or the paper rung's order builder), and this check is what tells it an order needs either. In
 * particular a breaching EXIT must be sliced, never simply blocked: a size cap must not trap a position the
 * book is leaving. Pure: no model, broker, clock, or network (T-05, under `risk/`).
 *
 * Every money input is real USD at order time. This engine is deliberately NOT wired into the shadow track yet:
 * the shadow book is synthetic (`SHADOW_INITIAL_CASH` is not dollars), so a USD notional cap has no meaning
 * against it until the owner decides what sleeve size the shadow book models (D-55).
 *
 * Three kinds of breach, and how each treats an exit (Codex P2, PR #109):
 *  - **Malformed orders** (`BAD_QUANTITY`, `BAD_PRICE`) are rejected on either side. The order itself is wrong,
 *    and a zero price would let an exit skip the notional cap.
 *  - **Size and count caps** apply to every order, exits included. Slicing across sessions cures them.
 *  - **Missing or unmeasurable data** (`ADV_UNKNOWN`, `BAD_NAV`, `SPREAD_UNOBSERVED`) fails closed for BUYS only.
 *    Slicing cannot cure missing data, so failing an exit on it would trap the position indefinitely. For a
 *    sell, the measurement it prevents is simply skipped.
 *
 * Checks, per order:
 *  - `BAD_QUANTITY` (non-positive or fractional: `fractionalShares` is false) and `QTY_CAP` (`maxOrderQuantity`).
 *  - `BAD_PRICE` (non-positive reference price: the notional is unknown) and `NOTIONAL_CAP` (`maxOrderNotionalUsd`).
 *    Notional, participation and turnover price a sell at the higher of its limit and the bid, since a sell limit
 *    below the market fills at about the bid; a buy's limit already bounds what it pays.
 *  - `ADV_PARTICIPATION`: notional at most the BINDING participation times 20-session dollar ADV (`ADV_UNKNOWN`
 *    for a buy without one; a sell without one skips the check). Binding is the stricter of `risk.yaml` `maxAdvParticipationPct` and the charter's
 *    `costs.max_participation_of_adv` - the cost model the backtest evidence assumed (the same stricter-of rule
 *    `evaluateRiskLimits` applies to `max_positions`).
 *  - Buys only (new risk): the shared instrument rule ({@link instrumentLiquidityViolations}: `MIN_ADV`,
 *    `MIN_PRICE`, the price floor read from the quote mid, never the order's limit price), and the spread at order
 *    time - `SPREAD` over `maxSpreadBps` of the quote mid, `BAD_QUOTE` for
 *    a crossed or non-positive quote, and `SPREAD_UNOBSERVED` when there is no quote (fails closed: end-of-day
 *    data carries none, so nothing before the paper rung can clear a buy here).
 *  - `SELL_EXCEEDS_HELD`: long-only, so the session's sells of an entity may not exceed the shares held.
 *
 * Per session:
 *  - `MAX_ORDERS_PER_SESSION` (`maxOrdersPerSession`).
 *  - `MAX_NEW_POSITIONS`: entities bought from flat, at most the stricter of `risk.yaml`
 *    `maxNewPositionsPerSession` and the charter's `max_new_positions_per_decision`.
 *  - `DAILY_TURNOVER`: gross traded notional (buys plus sells) over NAV, at most `maxDailyTurnoverPctNav`. Gross is
 *    the stricter reading of a cap the policy does not define further. A non-positive NAV leaves turnover
 *    unmeasurable: `BAD_NAV` when the session buys, unchecked when it only sells.
 */

export type OrderQuote = { bid: Dec; ask: Dec };

export type SessionOrder = {
  entityId: string;
  side: "BUY" | "SELL";
  /** Whole shares, positive; the side carries the direction. */
  quantity: Dec;
  /**
   * Reference price in USD: the limit price, or the adverse side of the quote for a market order. The size caps
   * price a SELL at the higher of this and the bid, because a sell limit is only a floor on its fill.
   */
  price: Dec;
  /** 20-session average daily dollar volume (USD). */
  advUsd: Dec | undefined;
  /** The quote at order time, when a quote source exists. */
  quote: OrderQuote | undefined;
};

export type OrderLimitsInput = {
  policy: RiskConfig;
  charter: Charter;
  /** Sleeve NAV in USD before the session's orders: the turnover denominator. */
  navUsd: Dec;
  /** Whole-share holdings before the session's orders, keyed by entity id. */
  held: ReadonlyMap<string, Dec>;
  orders: readonly SessionOrder[];
};

const BPS = new Dec(10000);
const TWO = new Dec(2);

/** The ADV participation that binds: the stricter of the sleeve policy and the charter's cost model. */
export function bindingAdvParticipation(policy: RiskConfig, charter: Charter): Dec {
  return Dec.min(new Dec(policy.liquidity.maxAdvParticipationPct), new Dec(charter.costs.max_participation_of_adv));
}

/** The new-position cap that binds: the stricter of the sleeve policy and the charter. */
export function bindingNewPositionsPerSession(policy: RiskConfig, charter: Charter): number {
  return Math.min(policy.positionLimits.maxNewPositionsPerSession, charter.rules.max_new_positions_per_decision);
}

/** A two-sided market: a positive bid and an ask not below it. */
function validQuote(q: OrderQuote | undefined): q is OrderQuote {
  return q !== undefined && q.bid.gt(0) && !q.ask.lt(q.bid);
}

/** The observed market price: the quote mid. An instrument fact, unlike the order's own reference price. */
function quoteMid(q: OrderQuote): Dec {
  return q.ask.plus(q.bid).div(TWO);
}

function spreadViolations(policy: RiskConfig, o: SessionOrder): LimitViolation[] {
  const tag = `BUY ${o.entityId}`;
  if (o.quote === undefined) return [{ code: "SPREAD_UNOBSERVED", detail: `${tag} has no quote at order time; the spread cannot be checked, so new risk fails closed` }];
  const { bid, ask } = o.quote;
  if (!validQuote(o.quote)) return [{ code: "BAD_QUOTE", detail: `${tag} quote bid ${bid.toFixed()} ask ${ask.toFixed()} is not a valid market` }];
  const spreadBps = ask.minus(bid).div(quoteMid(o.quote)).times(BPS);
  if (spreadBps.gt(new Dec(policy.liquidity.maxSpreadBps))) return [{ code: "SPREAD", detail: `${tag} spread ${spreadBps.toFixed(1)} bps exceeds maxSpreadBps ${policy.liquidity.maxSpreadBps}` }];
  return [];
}

export function evaluateOrderLimits(input: OrderLimitsInput): RiskVerdict {
  const p = input.policy;
  const v: LimitViolation[] = [];
  const qtyCap = new Dec(p.orderLimits.maxOrderQuantity);
  const notionalCap = new Dec(p.orderLimits.maxOrderNotionalUsd);
  const participation = bindingAdvParticipation(p, input.charter);
  const orders = [...input.orders].sort((a, b) => (a.entityId !== b.entityId ? (a.entityId < b.entityId ? -1 : 1) : a.side < b.side ? -1 : a.side > b.side ? 1 : 0));

  const notionals: Dec[] = [];
  const sold = new Map<string, Dec>();
  const entries = new Set<string>();
  for (const o of orders) {
    const tag = `${o.side} ${o.entityId}`;
    if (!o.quantity.gt(0) || !o.quantity.isInteger()) v.push({ code: "BAD_QUANTITY", detail: `${tag} quantity ${o.quantity.toFixed()} is not a positive whole number of shares` });
    else if (o.quantity.gt(qtyCap)) v.push({ code: "QTY_CAP", detail: `${tag} quantity ${o.quantity.toFixed()} exceeds maxOrderQuantity ${p.orderLimits.maxOrderQuantity}` });

    const priceOk = o.price.gt(0);
    const advOk = o.advUsd?.gt(0) === true;
    if (!priceOk) {
      v.push({ code: "BAD_PRICE", detail: `${tag} reference price ${o.price.toFixed()} is not positive; the notional is unknown` });
    } else {
      // The size caps bound what the order can trade, so they price it at the most it can fill for. A buy's limit
      // already caps its price. A sell's limit is only a floor: one set below the market fills at about the bid,
      // so a sell is priced at the higher of its limit and the bid (Codex P2, PR #109). With no valid quote a sell
      // is priced at its own price, a lower bound. Missing data never traps an exit, and the gateway's
      // fresh-quote requirement backstops it.
      const sizingPrice = o.side === "SELL" && validQuote(o.quote) ? Dec.max(o.price, o.quote.bid) : o.price;
      const notional = o.quantity.abs().times(sizingPrice);
      notionals.push(notional);
      if (notional.gt(notionalCap)) v.push({ code: "NOTIONAL_CAP", detail: `${tag} notional ${notional.toFixed(2)} USD exceeds maxOrderNotionalUsd ${p.orderLimits.maxOrderNotionalUsd}` });
      if (!advOk) {
        if (o.side === "BUY") v.push({ code: "ADV_UNKNOWN", detail: `${tag} has no usable ADV; participation cannot be checked, so new risk fails closed` });
      } else if (o.advUsd !== undefined && notional.gt(participation.times(o.advUsd))) {
        v.push({ code: "ADV_PARTICIPATION", detail: `${tag} notional ${notional.toFixed(2)} USD exceeds ${participation.toFixed()} of ADV ${o.advUsd.toFixed(0)} USD` });
      }
    }

    if (o.side === "BUY") {
      // The floors are instrument facts, so they read the observed market price (the quote mid), never the order's
      // own reference price: a limit price says what the order will pay, not what the instrument trades at (Codex
      // P2, PR #109). Unknown ADV is already reported above, and a missing or invalid quote fails the buy closed
      // in spreadViolations, so the shared rule then adds only the floors.
      if (advOk && validQuote(o.quote)) v.push(...instrumentLiquidityViolations(p, o.entityId, { advUsd: o.advUsd, price: quoteMid(o.quote) }));
      v.push(...spreadViolations(p, o));
      if (!(input.held.get(o.entityId)?.gt(0) ?? false)) entries.add(o.entityId);
    } else {
      sold.set(o.entityId, (sold.get(o.entityId) ?? ZERO).plus(o.quantity.abs()));
    }
  }

  for (const [id, qty] of [...sold].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const have = input.held.get(id) ?? ZERO;
    if (qty.gt(have)) v.push({ code: "SELL_EXCEEDS_HELD", detail: `SELL ${id} totals ${qty.toFixed()} shares but ${have.toFixed()} are held; the book is long-only` });
  }

  if (orders.length > p.orderLimits.maxOrdersPerSession) {
    v.push({ code: "MAX_ORDERS_PER_SESSION", detail: `${orders.length} orders exceed maxOrdersPerSession ${p.orderLimits.maxOrdersPerSession}` });
  }
  const maxNew = bindingNewPositionsPerSession(p, input.charter);
  if (entries.size > maxNew) {
    v.push({ code: "MAX_NEW_POSITIONS", detail: `${entries.size} new positions exceed the binding cap ${maxNew} (risk.yaml ${p.positionLimits.maxNewPositionsPerSession}, charter ${input.charter.rules.max_new_positions_per_decision})` });
  }
  if (!input.navUsd.gt(0)) {
    if (orders.some((o) => o.side === "BUY")) v.push({ code: "BAD_NAV", detail: `NAV ${input.navUsd.toFixed()} USD is not positive; turnover cannot be measured, so new risk fails closed` });
  } else if (orders.length > 0) {
    const turnover = sumDec(notionals).div(input.navUsd);
    if (turnover.gt(new Dec(p.orderLimits.maxDailyTurnoverPctNav))) {
      v.push({ code: "DAILY_TURNOVER", detail: `gross traded notional is ${turnover.toFixed(4)} of NAV, above maxDailyTurnoverPctNav ${p.orderLimits.maxDailyTurnoverPctNav}` });
    }
  }

  return { admitted: v.length === 0, violations: v };
}
