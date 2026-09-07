import {
  epochMs,
  isLiveMode,
  type Dec,
  type Mode,
  type OrderType,
  type Side,
  type TimeInForce,
  type UtcInstant,
} from "@blackgold/shared";
import { HardCapViolation, LiveModeUnavailableError } from "../errors.ts";
import type { OrderIntent, Verdict } from "../types.ts";

export type HardCapConfig = {
  /** Second copy of the sleeve check; the allowlist is the first. */
  sleeveAccountId: string;
  maxOrderNotional: Dec;
  maxOrderQty: Dec;
  allowedOrderTypes: readonly OrderType[];
  allowedTimeInForce: readonly TimeInForce[];
  allowedSides: readonly Side[];
  /** A quote older than this (or from the future) fails closed. */
  maxQuoteAgeMs: number;
};

export const HARD_CAP_REASONS = [
  "ACCOUNT_MISMATCH",
  "LIVE_UNAVAILABLE",
  "NOTIONAL_CAP",
  "QTY_CAP",
  "BAD_QTY",
  "ORDER_TYPE",
  "TIF",
  "SIDE",
  "EXTENDED_HOURS",
  "FRACTIONAL",
  "STALE_QUOTE",
  "BAD_LIMIT",
] as const;
export type HardCapReason = (typeof HARD_CAP_REASONS)[number];

/**
 * Gateway-side re-check of every hard cap. Core already checked; this is the second, independent layer.
 * Every failing check contributes a reason code; the verdict is the union, so a rejection explains itself.
 */
export class HardCaps {
  readonly config: HardCapConfig;

  constructor(config: HardCapConfig) {
    if (!config.maxOrderNotional.gt(0) || !config.maxOrderQty.gt(0)) {
      throw new RangeError("hard caps must be positive");
    }
    if (config.maxQuoteAgeMs <= 0) throw new RangeError("maxQuoteAgeMs must be positive");
    this.config = config;
  }

  /** Phase 0 has no live path and no authorization verifier: every live mode is refused, always. */
  assertMode(mode: Mode): void {
    if (isLiveMode(mode)) throw new LiveModeUnavailableError(mode);
  }

  check(intent: OrderIntent, now: UtcInstant): Verdict {
    const c = this.config;
    const reasons: HardCapReason[] = [];
    const fail = (r: HardCapReason): void => {
      if (!reasons.includes(r)) reasons.push(r);
    };

    if (intent.sleeveAccountId !== c.sleeveAccountId) fail("ACCOUNT_MISMATCH");
    if (isLiveMode(intent.mode)) fail("LIVE_UNAVAILABLE");
    if (!c.allowedSides.includes(intent.side)) fail("SIDE");
    if (!c.allowedOrderTypes.includes(intent.orderType)) fail("ORDER_TYPE");
    if (!c.allowedTimeInForce.includes(intent.timeInForce)) fail("TIF");
    if (intent.extendedHours === true) fail("EXTENDED_HOURS");

    if (!intent.quantity.gt(0)) fail("BAD_QTY");
    if (!intent.quantity.isInteger()) fail("FRACTIONAL");
    if (intent.quantity.gt(c.maxOrderQty)) fail("QTY_CAP");

    if (intent.orderType === "LIMIT" && !(intent.limitPrice?.gt(0) ?? false)) {
      fail("BAD_LIMIT");
    }

    const quoteAge = epochMs(now) - epochMs(intent.quote.at);
    if (Number.isNaN(quoteAge) || quoteAge < 0 || quoteAge > c.maxQuoteAgeMs) fail("STALE_QUOTE");

    const price = referencePrice(intent);
    if (price === undefined) {
      fail("BAD_LIMIT");
    } else if (!price.gt(0)) {
      fail("BAD_LIMIT");
    } else if (intent.quantity.times(price).gt(c.maxOrderNotional)) {
      fail("NOTIONAL_CAP");
    }

    return { ok: reasons.length === 0, reasonCodes: reasons };
  }

  /** Throw variant: LiveModeUnavailableError for any live mode, HardCapViolation for everything else. */
  assert(intent: OrderIntent, now: UtcInstant): void {
    this.assertMode(intent.mode);
    const v = this.check(intent, now);
    if (!v.ok) throw new HardCapViolation(v.reasonCodes);
  }
}

/** Notional uses the limit price for LIMIT orders and the adverse side of the quote for MARKET orders. */
function referencePrice(intent: OrderIntent): Dec | undefined {
  if (intent.orderType === "LIMIT") return intent.limitPrice;
  return intent.side === "BUY" ? intent.quote.ask : intent.quote.bid;
}
