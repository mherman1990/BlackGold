import { Dec } from "@blackgold/shared";
import type { RiskConfig } from "../config/schema.ts";
import type { LimitViolation, RiskVerdict } from "./limits.ts";

/**
 * The deterministic instrument-liquidity guard (docs/PRODUCT_SPEC.md section 8, `risk.yaml` `liquidity`; the
 * liquidity half of the follow-up D-45 deferred, D-55).
 *
 * An instrument may take NEW or INCREASED risk only when its 20-session average daily dollar volume is at least
 * `minAdvUsd` and its unadjusted price is at least `minPriceUsd`. Both are real-USD facts from raw bars (the
 * charter's `adv_i` and `px_i`), so the check is meaningful even against the synthetic shadow book, whose
 * denomination is not dollars. Pure: policy and facts in, verdict out - no model, broker, or network (T-05,
 * under `risk/`). It admits or rejects with reason codes; it never re-sizes.
 *
 * Fail closed: a holding taking new risk with no ADV or price, or a non-positive one, cannot be checked and is
 * rejected (`LIQUIDITY_UNKNOWN`) - spec section 11, unknown state blocks new risk. A hold or a reduction is not
 * new risk and is never blocked here: liquidity must not trap a position the book is trying to leave.
 *
 * Not checked here, deliberately:
 *  - **Spread** (`maxSpreadBps`). End-of-day bars carry no quote, so a spread cannot be observed at the decision
 *    instant; the spread that matters is the one at order time. It is an order-level check
 *    ({@link evaluateOrderLimits} in `orders.ts`), where a missing quote fails closed for a buy.
 *  - **ADV participation** (`maxAdvParticipationPct`). It bounds an order's size, so it needs a quantity; it is
 *    also order-level.
 */

export type LiquidityFacts = {
  /** 20-session average daily dollar volume from raw closes and volumes (USD). */
  advUsd: Dec | undefined;
  /** Unadjusted close at the decision anchor, or the order's reference price at order time (USD). */
  price: Dec | undefined;
};

export type LiquidityInput = {
  policy: RiskConfig;
  /**
   * The holdings taking new or increased risk. The decision gate passes the set it derives from the target and
   * current books, so coverage is enforced, not trusted: a holding with no facts here fails closed.
   */
  increasing: readonly string[];
  /** Liquidity facts keyed by entity id, as the book is. */
  facts: ReadonlyMap<string, LiquidityFacts>;
};

/**
 * The per-instrument admission rule, shared by the decision gate (through {@link evaluateLiquidityLimits}) and
 * the order-level engine (for every buy), so the two layers cannot disagree on it.
 */
export function instrumentLiquidityViolations(policy: RiskConfig, entityId: string, facts: LiquidityFacts | undefined): LimitViolation[] {
  const advUsd = facts?.advUsd;
  const price = facts?.price;
  if (advUsd?.gt(0) !== true || price?.gt(0) !== true) {
    const what = advUsd?.gt(0) !== true ? (price?.gt(0) !== true ? "ADV and price" : "ADV") : "price";
    return [{ code: "LIQUIDITY_UNKNOWN", detail: `${entityId} has no usable ${what}; liquidity cannot be checked, so new risk fails closed` }];
  }
  const v: LimitViolation[] = [];
  const minAdv = new Dec(policy.liquidity.minAdvUsd);
  if (advUsd.lt(minAdv)) v.push({ code: "MIN_ADV", detail: `${entityId} ADV ${advUsd.toFixed(0)} USD is below minAdvUsd ${policy.liquidity.minAdvUsd}` });
  const minPrice = new Dec(policy.liquidity.minPriceUsd);
  if (price.lt(minPrice)) v.push({ code: "MIN_PRICE", detail: `${entityId} price ${price.toFixed()} USD is below minPriceUsd ${policy.liquidity.minPriceUsd}` });
  return v;
}

export function evaluateLiquidityLimits(input: LiquidityInput): RiskVerdict {
  const violations = [...new Set(input.increasing)].sort().flatMap((id) => instrumentLiquidityViolations(input.policy, id, input.facts.get(id)));
  return { admitted: violations.length === 0, violations };
}
