import {
  ZERO,
  decToString,
  deterministicId,
  nowUtc,
  type Dec,
  type OrderState,
  type Side,
  type UtcInstant,
} from "@blackgold/shared";
import { AccountBoundaryViolation } from "../../errors.ts";
import type {
  BrokerEvent,
  BrokerOrderSnapshot,
  BrokerTradingAdapter,
  OrderIntent,
  Position,
  SubmitOutcome,
} from "../../types.ts";

/**
 * Fault injection plan for one order. Everything is deterministic: ids derive from the seed and a counter.
 *  - onSubmit "timeout": the broker never received the order; the gateway sees UNKNOWN.
 *  - onSubmit "ack_after_timeout": the broker accepted the order but the response was lost; the gateway sees
 *    UNKNOWN while orderStatus() reflects the accepted order. This is the UNKNOWN -> reconcile case.
 */
export type FaultPlan = {
  onSubmit?: "ack" | "reject" | "timeout" | "ack_after_timeout";
  /** Fills applied in order after acceptance; the one reaching the full quantity is a `fill`, earlier ones `partial_fill`. */
  fills?: readonly { qty: Dec; price: Dec }[];
  /** Protective-leg outcome once the order is fully filled. "partial" covers only half the quantity. */
  protection?: "ack" | "reject" | "partial";
  cancel?: "ack" | "race_fill" | "timeout";
  duplicateEvents?: boolean;
  outOfOrder?: boolean;
};

type BrokerOrder = {
  clientOrderId: string;
  brokerOrderId: string;
  symbol: string;
  side: Side;
  quantity: Dec;
  referencePrice: Dec;
  filledQty: Dec;
  avgFillPrice: Dec | undefined;
  protectionConfirmedQty: Dec;
  state: OrderState;
  lastEventAt: UtcInstant;
};

const OPEN: ReadonlySet<OrderState> = new Set<OrderState>(["ACKNOWLEDGED", "PARTIALLY_FILLED"]);

export class SyntheticBroker implements BrokerTradingAdapter {
  readonly allowedAccountId: string;
  readonly seed: string;
  readonly clock: () => UtcInstant;
  private readonly orders = new Map<string, BrokerOrder>();
  private readonly plans = new Map<string, FaultPlan>();
  private defaultPlan: FaultPlan = { onSubmit: "ack" };
  private queue: BrokerEvent[] = [];
  private counter = 0;
  private submitCalls = 0;

  constructor(opts: { allowedAccountId: string; seed?: string | number; clock?: () => UtcInstant }) {
    if (opts.allowedAccountId.trim().length === 0) throw new AccountBoundaryViolation("empty account id");
    this.allowedAccountId = opts.allowedAccountId;
    this.seed = String(opts.seed ?? "synthetic");
    this.clock = opts.clock ?? (() => nowUtc());
  }

  /** Inject a plan for one client order id. Orders without a plan use the default plan (clean ack, no fills). */
  plan(clientOrderId: string, plan: FaultPlan): this {
    this.plans.set(clientOrderId, plan);
    return this;
  }

  setDefaultPlan(plan: FaultPlan): this {
    this.defaultPlan = plan;
    return this;
  }

  /** Drain every event emitted since the last drain, in emission order. */
  events(): BrokerEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** Number of orders the broker actually holds. A blind retry after UNKNOWN would make this 2. */
  orderCount(): number {
    return this.orders.size;
  }

  submitCallCount(): number {
    return this.submitCalls;
  }

  submit(intent: OrderIntent): Promise<SubmitOutcome> {
    this.submitCalls++;
    // Belt and braces: the gateway already checked, and the adapter refuses anyway.
    if (intent.sleeveAccountId !== this.allowedAccountId) {
      throw new AccountBoundaryViolation("synthetic broker received a non-sleeve intent");
    }
    const plan = this.planFor(intent.clientOrderId);
    const mode = plan.onSubmit ?? "ack";
    switch (mode) {
      case "timeout":
        return Promise.resolve({ state: "UNKNOWN" });
      case "reject": {
        this.emit([this.event(intent.clientOrderId, { kind: "reject", reason: "SYNTHETIC_REJECT" })], plan);
        return Promise.resolve({ rejected: "SYNTHETIC_REJECT" });
      }
      case "ack":
      case "ack_after_timeout": {
        const brokerOrderId = this.accept(intent, plan);
        return Promise.resolve(mode === "ack" ? { brokerOrderId } : { state: "UNKNOWN" });
      }
    }
  }

  /** Broker truth for a client order id. If a blind resubmit created two broker orders, the first one is reported. */
  private byClientOrderId(clientOrderId: string): BrokerOrder | undefined {
    for (const o of this.orders.values()) if (o.clientOrderId === clientOrderId) return o;
    return undefined;
  }

  orderStatus(clientOrderId: string): Promise<BrokerOrderSnapshot | undefined> {
    const o = this.byClientOrderId(clientOrderId);
    return Promise.resolve(o ? toSnapshot(o) : undefined);
  }

  cancel(clientOrderId: string): Promise<"CANCEL_PENDING" | "UNKNOWN"> {
    const o = this.byClientOrderId(clientOrderId);
    if (!o) return Promise.resolve("UNKNOWN");
    const plan = this.planFor(clientOrderId);
    switch (plan.cancel ?? "ack") {
      case "timeout":
        return Promise.resolve("UNKNOWN");
      case "race_fill": {
        // The fill beat the cancel: the broker reports a fill, and the cancel request is moot.
        const remaining = o.quantity.minus(o.filledQty);
        if (remaining.gt(ZERO) && OPEN.has(o.state)) {
          this.emit([this.applyFill(o, remaining, o.referencePrice)], plan);
        }
        return Promise.resolve("CANCEL_PENDING");
      }
      case "ack": {
        if (OPEN.has(o.state)) {
          o.state = "CANCELED";
          o.lastEventAt = this.clock();
          this.emit([this.event(clientOrderId, { kind: "cancel_ack" })], plan);
        }
        return Promise.resolve("CANCEL_PENDING");
      }
    }
  }

  openOrders(): Promise<BrokerOrderSnapshot[]> {
    return Promise.resolve([...this.orders.values()].filter((o) => OPEN.has(o.state)).map(toSnapshot));
  }

  positions(): Promise<Position[]> {
    const at = this.clock();
    const bySymbol = new Map<string, Dec>();
    for (const o of this.orders.values()) {
      const signed = o.side === "BUY" ? o.filledQty : o.filledQty.negated();
      bySymbol.set(o.symbol, (bySymbol.get(o.symbol) ?? ZERO).plus(signed));
    }
    return Promise.resolve(
      [...bySymbol.entries()]
        .filter(([, q]) => !q.isZero())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([symbol, quantity]) => ({ symbol, quantity, asOf: at })),
    );
  }

  // ---- internals ----

  private planFor(clientOrderId: string): FaultPlan {
    return this.plans.get(clientOrderId) ?? this.defaultPlan;
  }

  private accept(intent: OrderIntent, plan: FaultPlan): string {
    const brokerOrderId = deterministicId("bo", this.seed, ++this.counter);
    const order: BrokerOrder = {
      clientOrderId: intent.clientOrderId,
      brokerOrderId,
      symbol: intent.symbol,
      side: intent.side,
      quantity: intent.quantity,
      referencePrice: intent.limitPrice ?? (intent.side === "BUY" ? intent.quote.ask : intent.quote.bid),
      filledQty: ZERO,
      avgFillPrice: undefined,
      protectionConfirmedQty: ZERO,
      state: "ACKNOWLEDGED",
      lastEventAt: this.clock(),
    };
    // A second accept for the same client order id is a second broker order. Real brokers may dedupe; the
    // synthetic one deliberately does not, so a blind resubmit shows up in orderCount().
    this.orders.set(brokerOrderId, order);
    const events: BrokerEvent[] = [this.event(intent.clientOrderId, { kind: "ack", brokerOrderId })];
    for (const f of plan.fills ?? []) {
      if (!OPEN.has(order.state)) break;
      events.push(this.applyFill(order, f.qty, f.price));
    }
    if (order.state === "FILLED" && plan.protection) {
      switch (plan.protection) {
        case "ack":
          order.protectionConfirmedQty = order.quantity;
          events.push(this.event(order.clientOrderId, { kind: "protection_ack", coveredQty: order.quantity }));
          break;
        case "partial": {
          const half = order.quantity.div(2).floor();
          order.protectionConfirmedQty = half;
          events.push(this.event(order.clientOrderId, { kind: "protection_ack", coveredQty: half }));
          break;
        }
        case "reject":
          events.push(this.event(order.clientOrderId, { kind: "protection_reject", reason: "SYNTHETIC_PROTECTION_REJECT" }));
          break;
      }
    }
    this.emit(events, plan);
    return brokerOrderId;
  }

  private applyFill(o: BrokerOrder, qty: Dec, price: Dec): BrokerEvent {
    const prevNotional = (o.avgFillPrice ?? ZERO).times(o.filledQty);
    o.filledQty = o.filledQty.plus(qty);
    o.avgFillPrice = prevNotional.plus(price.times(qty)).div(o.filledQty);
    o.lastEventAt = this.clock();
    if (o.filledQty.gte(o.quantity)) {
      o.state = "FILLED";
      return this.event(o.clientOrderId, { kind: "fill", qty, price });
    }
    o.state = "PARTIALLY_FILLED";
    return this.event(o.clientOrderId, { kind: "partial_fill", qty, price });
  }

  private event(clientOrderId: string, body: EventBody): BrokerEvent {
    const eventId = deterministicId("evt", this.seed, ++this.counter);
    return { ...body, eventId, clientOrderId, at: this.clock() };
  }

  private emit(events: BrokerEvent[], plan: FaultPlan): void {
    const ordered = plan.outOfOrder ? [...events].reverse() : events;
    for (const e of ordered) {
      this.queue.push(e);
      if (plan.duplicateEvents) this.queue.push({ ...e });
    }
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<BrokerEvent, "eventId" | "clientOrderId" | "at">;

function toSnapshot(o: BrokerOrder): BrokerOrderSnapshot {
  const snap: BrokerOrderSnapshot = {
    clientOrderId: o.clientOrderId,
    brokerOrderId: o.brokerOrderId,
    state: o.state,
    filledQty: o.filledQty,
    protectionConfirmedQty: o.protectionConfirmedQty,
    lastEventAt: o.lastEventAt,
  };
  if (o.avgFillPrice !== undefined) snap.avgFillPrice = o.avgFillPrice;
  return snap;
}

/** Debug rendering for test failures; never includes account identifiers. */
export function describeSnapshot(s: BrokerOrderSnapshot): string {
  return `${s.clientOrderId} ${s.state} filled=${decToString(s.filledQty)} protected=${decToString(s.protectionConfirmedQty)}`;
}
