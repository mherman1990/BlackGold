/** Error types raised by the gateway. Messages never include account numbers, tokens, or balances. */

export class DuplicateIntentError extends Error {
  readonly clientOrderId: string;
  constructor(clientOrderId: string) {
    super(`Intent already persisted for client order ${clientOrderId}`);
    this.name = "DuplicateIntentError";
    this.clientOrderId = clientOrderId;
  }
}

export class UnknownOrderError extends Error {
  readonly clientOrderId: string;
  constructor(clientOrderId: string) {
    super(`No persisted order for client order ${clientOrderId}`);
    this.name = "UnknownOrderError";
    this.clientOrderId = clientOrderId;
  }
}

/** An intent named an account other than the single registered sleeve. Never includes the offending id. */
export class AccountBoundaryViolation extends Error {
  constructor(detail = "intent sleeveAccountId does not match the allowlisted sleeve account") {
    super(`Account boundary violation: ${detail}`);
    this.name = "AccountBoundaryViolation";
  }
}

export class AllowlistConfigError extends Error {
  constructor(detail: string) {
    super(`Invalid sleeve allowlist: ${detail}`);
    this.name = "AllowlistConfigError";
  }
}

/** Phase 0 has no live code path and no LIVE_AUTHORIZATION verifier; every live mode is refused. */
export class LiveModeUnavailableError extends Error {
  readonly mode: string;
  constructor(mode: string) {
    super(`Live mode ${mode} is unavailable: no live trading path exists in this build`);
    this.name = "LiveModeUnavailableError";
    this.mode = mode;
  }
}

export class HardCapViolation extends Error {
  readonly reasonCodes: readonly string[];
  constructor(reasonCodes: readonly string[]) {
    super(`Hard cap violation: ${reasonCodes.join(",")}`);
    this.name = "HardCapViolation";
    this.reasonCodes = reasonCodes;
  }
}

/** The read-only view was asked about an account it does not hold. The message never echoes the reference. */
export class UnknownAccountError extends Error {
  constructor() {
    super("Unknown account reference");
    this.name = "UnknownAccountError";
  }
}
