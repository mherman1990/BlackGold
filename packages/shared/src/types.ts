/** Domain-wide constant vocabularies. Kept as `as const` tuples so they are erasable and exhaustively checkable. */

export const MODES = ["RESEARCH", "BACKTEST", "SHADOW", "PAPER", "LIVE_MANUAL", "LIVE_LIMITED"] as const;
export type Mode = (typeof MODES)[number];

/** Modes that may never reach a real broker in Phase 0 through Phase 5. */
export const LIVE_MODES: readonly Mode[] = ["LIVE_MANUAL", "LIVE_LIMITED"];
export function isLiveMode(mode: Mode): boolean {
  return LIVE_MODES.includes(mode);
}

export const HALT_STATES = ["NORMAL", "HALT_NEW_RISK", "HOLD_ONLY", "EMERGENCY_FLATTEN_AUTHORIZED"] as const;
export type HaltState = (typeof HALT_STATES)[number];

export const ARMS = ["B0_PASSIVE", "B1_DETERMINISTIC", "C1_LLM_OVERLAY", "D1_LLM_ONLY_SHADOW"] as const;
export type Arm = (typeof ARMS)[number];

export const ORDER_STATES = [
  "CREATED",
  "VALIDATED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "SUBMITTING",
  "UNKNOWN",
  "ACKNOWLEDGED",
  "PARTIALLY_FILLED",
  "FILLED",
  "PROTECTION_PENDING",
  "PROTECTED",
  "PROTECTION_FAILED",
  "CANCEL_PENDING",
  "CANCELED",
  "REJECTED",
  "EXIT_PENDING",
  "CLOSED",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const ACCOUNT_ROLES = ["blackgold_sleeve", "read_only"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
export const SLEEVE_ROLE: AccountRole = "blackgold_sleeve";

export type Side = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type TimeInForce = "DAY" | "GTC";
