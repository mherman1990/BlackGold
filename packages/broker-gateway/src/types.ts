import type { Dec, Mode, OrderState, OrderType, Sha256Hex, Side, TimeInForce, UtcInstant } from "@blackgold/shared";

/**
 * Gateway-side port of docs/CORE_INTERFACES.md "Orders and gateway".
 * Money and quantity are `Dec`, never `number`. Instants are `UtcInstant`.
 * Phase 0: no live path exists. These types describe the seam the synthetic adapter fills.
 */

export type Verdict = { ok: boolean; reasonCodes: string[] };

export type ProtectionConstruct = "NATIVE_BRACKET" | "NATIVE_OCO";

export type OrderIntent = {
  intentId: string;
  /** Deterministic: see clientOrderIdFor(). The gateway recomputes and rejects a mismatch. */
  clientOrderId: string;
  /** Supplied by trusted code; the gateway re-checks against its single-entry allowlist; never inferred. */
  sleeveAccountId: string;
  mode: Mode;
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  side: Side;
  quantity: Dec;
  orderType: OrderType;
  limitPrice?: Dec;
  timeInForce: TimeInForce;
  /** Regular session only. Anything else is rejected by the hard caps. */
  extendedHours?: boolean;
  protection?: { stopPrice: Dec; construct: ProtectionConstruct };
  quote: { bid: Dec; ask: Dec; venue: string; at: UtcInstant };
  riskSnapshotHash: Sha256Hex;
  complianceVerdict: Verdict;
  riskVerdict: Verdict;
  /** LIVE_AUTHORIZATION id; required for LIVE_* modes. Phase 0 has no verifier, so live is always rejected. */
  authorizationRef?: string;
  approval?: { by: string; at: UtcInstant; signature: string };
  /** The decision instant the intent derives from; an input to the deterministic client order id. */
  decisionAt: UtcInstant;
  createdAt: UtcInstant;
};

export type BrokerOrderSnapshot = {
  clientOrderId: string;
  brokerOrderId?: string;
  state: OrderState;
  filledQty: Dec;
  avgFillPrice?: Dec;
  /** Quantity the broker has confirmed as covered by a protective order. PROTECTED requires this >= filledQty. */
  protectionConfirmedQty: Dec;
  lastEventAt: UtcInstant;
};

export type Position = {
  symbol: string;
  quantity: Dec;
  averageCost?: Dec;
  asOf: UtcInstant;
};

export type Balances = {
  cash: Dec;
  equity: Dec;
  asOf: UtcInstant;
};

/** Read-only view for non-sleeve accounts. There is no mutating counterpart. Positions and balances ONLY. */
export interface ReadOnlyAccountView {
  positions(accountRef: string): Promise<Position[]>;
  balances(accountRef: string): Promise<Balances>;
}

/** Trading interface. Only the gateway implements it; only the sleeve account id is accepted. */
export interface BrokerTradingAdapter {
  readonly allowedAccountId: string;
  submit(intent: OrderIntent): Promise<SubmitOutcome>;
  orderStatus(clientOrderId: string): Promise<BrokerOrderSnapshot | undefined>;
  cancel(clientOrderId: string): Promise<"CANCEL_PENDING" | "UNKNOWN">;
  openOrders(): Promise<BrokerOrderSnapshot[]>;
  positions(): Promise<Position[]>;
}
// Absent by design: withdraw, transfer, journal, updateProfile, listAccounts-with-write, rawRequest.

export type SubmitOutcome = { brokerOrderId: string } | { state: "UNKNOWN" } | { rejected: string };

type EventBase = { eventId: string; clientOrderId: string; at: UtcInstant };

/** Events the broker (or its adapter) reports back. Processing is idempotent by eventId. */
export type BrokerEvent =
  | (EventBase & { kind: "ack"; brokerOrderId: string })
  | (EventBase & { kind: "reject"; reason: string })
  /**
   * Fill events carry the broker's CUMULATIVE truth (`cumulativeQty`, `avgPrice`) alongside this event's delta
   * (`qty`, `price`). The store applies the cumulative values, so out-of-order delivery cannot corrupt totals.
   */
  | (EventBase & { kind: "partial_fill"; qty: Dec; price: Dec; cumulativeQty: Dec; avgPrice: Dec })
  | (EventBase & { kind: "fill"; qty: Dec; price: Dec; cumulativeQty: Dec; avgPrice: Dec })
  | (EventBase & { kind: "cancel_ack" })
  | (EventBase & { kind: "protection_ack"; coveredQty: Dec })
  | (EventBase & { kind: "protection_reject"; reason: string })
  | (EventBase & { kind: "unknown_timeout" });

export type BrokerEventKind = BrokerEvent["kind"];
