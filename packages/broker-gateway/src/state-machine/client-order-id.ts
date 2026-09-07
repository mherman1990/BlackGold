import { decToString, deterministicId, type Dec, type Side, type UtcInstant } from "@blackgold/shared";

export type ClientOrderIdFields = {
  intentId: string;
  strategyVersion: string;
  symbol: string;
  side: Side;
  quantity: Dec;
  decisionAt: UtcInstant;
};

/**
 * Deterministic client order id: a pure function of the declared inputs (CORE_INTERFACES property 4).
 * The same intent always maps to the same id, so a retry after UNKNOWN can be correlated with broker truth
 * instead of resubmitted blindly.
 */
export function clientOrderIdFor(f: ClientOrderIdFields): string {
  return deterministicId("ord", f.strategyVersion, f.symbol, f.side, decToString(f.quantity), f.decisionAt, f.intentId);
}
