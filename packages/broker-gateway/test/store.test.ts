import { describe, expect, it } from "vitest";
import { dec, openDatabase, utc, type UtcInstant } from "@blackgold/shared";
import {
  DuplicateIntentError,
  IllegalTransitionError,
  OrderStore,
  UnknownOrderError,
  type BrokerEvent,
  type BrokerTradingAdapter,
} from "../src/index.ts";
import { T0, makeIntent } from "./helpers.ts";

function newStore(): OrderStore {
  return new OrderStore(openDatabase(":memory:"), () => T0);
}

let seq = 0;
type EventBody = BrokerEvent extends infer E ? (E extends BrokerEvent ? Omit<E, "eventId" | "clientOrderId" | "at"> : never) : never;
function ev(
  clientOrderId: string,
  body: EventBody,
  eventId = `evt_${String(++seq).padStart(4, "0")}`,
  at: UtcInstant = T0,
): BrokerEvent {
  return { ...body, eventId, clientOrderId, at };
}

/** Drive a persisted intent to ACKNOWLEDGED through the legal path. */
function ack(store: OrderStore, clientOrderId: string): void {
  store.transition(clientOrderId, "VALIDATED", "test");
  store.transition(clientOrderId, "APPROVED", "test");
  store.transition(clientOrderId, "SUBMITTING", "test");
  store.transition(clientOrderId, "ACKNOWLEDGED", "test", { patch: { brokerOrderId: "bo_fixture" } });
}

describe("OrderStore.persistIntent", () => {
  it("writes the intent row before any adapter call, even when the adapter throws", async () => {
    const store = newStore();
    const intent = makeIntent();
    const adapter: Pick<BrokerTradingAdapter, "submit"> = {
      submit: () => Promise.reject(new Error("connection reset")),
    };
    store.persistIntent(intent);
    await expect(adapter.submit(intent)).rejects.toThrow("connection reset");
    const snap = store.snapshot(intent.clientOrderId);
    expect(snap?.state).toBe("CREATED");
    expect(store.intent(intent.clientOrderId)?.intentId).toBe(intent.intentId);
    expect(store.history(intent.clientOrderId).map((t) => t.toState)).toEqual(["CREATED"]);
  });

  it("throws DuplicateIntentError on a second persist of the same client order id", () => {
    const store = newStore();
    const intent = makeIntent();
    store.persistIntent(intent);
    expect(() => {
      store.persistIntent(intent);
    }).toThrow(DuplicateIntentError);
    // A different intent id that collides on client order id is also a duplicate.
    expect(() => {
      store.persistIntent({ ...intent, intentId: "intent_other" });
    }).toThrow(DuplicateIntentError);
    expect(store.openOrders()).toHaveLength(1);
  });

  it("round-trips every intent field including decimals and optional protection", () => {
    const store = newStore();
    const intent = makeIntent({
      protection: { stopPrice: dec("440.50"), construct: "NATIVE_BRACKET" },
      approval: { by: "owner", at: T0, signature: "sig-fixture" },
      authorizationRef: undefined,
    });
    store.persistIntent(intent);
    const back = store.intent(intent.clientOrderId);
    expect(back).toBeDefined();
    if (!back) return;
    expect(back.quantity.eq(intent.quantity)).toBe(true);
    expect(back.limitPrice?.eq(dec("450.00"))).toBe(true);
    expect(back.protection?.stopPrice.eq(dec("440.5"))).toBe(true);
    expect(back.protection?.construct).toBe("NATIVE_BRACKET");
    expect(back.quote.at).toBe(intent.quote.at);
    expect(back.approval).toEqual(intent.approval);
    expect("authorizationRef" in back).toBe(false);
  });
});

describe("OrderStore.transition", () => {
  it("rejects illegal transitions and leaves state untouched", () => {
    const store = newStore();
    const intent = makeIntent();
    store.persistIntent(intent);
    expect(() => store.transition(intent.clientOrderId, "FILLED", "nope")).toThrow(IllegalTransitionError);
    expect(store.snapshot(intent.clientOrderId)?.state).toBe("CREATED");
    expect(store.history(intent.clientOrderId)).toHaveLength(1);
  });

  it("throws UnknownOrderError for an order that was never persisted", () => {
    const store = newStore();
    expect(() => store.transition("ord_missing", "VALIDATED", "x")).toThrow(UnknownOrderError);
  });

  it("only lets UNKNOWN exit through a reconciliation reason", () => {
    const store = newStore();
    const intent = makeIntent();
    store.persistIntent(intent);
    store.transition(intent.clientOrderId, "VALIDATED", "t");
    store.transition(intent.clientOrderId, "APPROVED", "t");
    store.transition(intent.clientOrderId, "SUBMITTING", "t");
    store.transition(intent.clientOrderId, "UNKNOWN", "timeout");
    expect(() => store.transition(intent.clientOrderId, "ACKNOWLEDGED", "retry")).toThrow(IllegalTransitionError);
    expect(store.snapshot(intent.clientOrderId)?.state).toBe("UNKNOWN");
    const snap = store.transition(intent.clientOrderId, "ACKNOWLEDGED", "reconciliation:broker_status");
    expect(snap.state).toBe("ACKNOWLEDGED");
  });

  it("closes from FILLED only for exits (SELL)", () => {
    const store = newStore();
    const buy = makeIntent({ intentId: "intent_buy" });
    const sell = makeIntent({ intentId: "intent_sell", side: "SELL" });
    for (const i of [buy, sell]) {
      store.persistIntent(i);
      ack(store, i.clientOrderId);
      store.transition(i.clientOrderId, "FILLED", "t", { patch: { filledQty: dec(100), avgFillPrice: dec("450") } });
    }
    expect(() => store.transition(buy.clientOrderId, "CLOSED", "t")).toThrow(IllegalTransitionError);
    expect(store.transition(sell.clientOrderId, "CLOSED", "t").state).toBe("CLOSED");
  });

  it("applies patches atomically with the state change", () => {
    const store = newStore();
    const intent = makeIntent();
    store.persistIntent(intent);
    ack(store, intent.clientOrderId);
    const snap = store.snapshot(intent.clientOrderId);
    expect(snap?.brokerOrderId).toBe("bo_fixture");
    expect(snap?.filledQty.isZero()).toBe(true);
    expect(snap?.protectionConfirmedQty.isZero()).toBe(true);
    expect(snap?.lastEventAt).toBe(T0);
  });
});

describe("order_transitions is append-only", () => {
  it("raises on UPDATE and DELETE via triggers", () => {
    const db = openDatabase(":memory:");
    const store = new OrderStore(db, () => T0);
    const intent = makeIntent();
    store.persistIntent(intent);
    expect(() => db.prepare("UPDATE order_transitions SET reason = 'tampered'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM order_transitions").run()).toThrow(/append-only/);
    const rows = db.prepare("SELECT reason FROM order_transitions").all();
    expect(rows).toEqual([{ reason: "intent_persisted" }]);
  });

  it("migrations are idempotent when the store is opened twice on the same database", () => {
    const db = openDatabase(":memory:");
    new OrderStore(db, () => T0);
    expect(() => new OrderStore(db, () => T0)).not.toThrow();
  });
});

describe("OrderStore.applyBrokerEvent", () => {
  it("ignores a duplicate event id and records nothing twice", () => {
    const store = newStore();
    const intent = makeIntent();
    store.persistIntent(intent);
    ack(store, intent.clientOrderId);
    const fill = ev(intent.clientOrderId, { kind: "partial_fill", qty: dec(30), price: dec("450"), cumulativeQty: dec(30), avgPrice: dec("450") }, "evt_dup");
    const first = store.applyBrokerEvent(fill);
    const before = store.history(intent.clientOrderId).length;
    const second = store.applyBrokerEvent({ ...fill });
    expect(first).toMatchObject({ applied: true, state: "PARTIALLY_FILLED" });
    expect(second).toMatchObject({ applied: false, state: "PARTIALLY_FILLED", reason: "duplicate_event" });
    expect(store.snapshot(intent.clientOrderId)?.filledQty.eq(dec(30))).toBe(true);
    expect(store.history(intent.clientOrderId)).toHaveLength(before);
  });

  it("records an out-of-order fill after cancel_ack as reconciliation_needed instead of throwing", () => {
    const store = newStore();
    const intent = makeIntent();
    store.persistIntent(intent);
    ack(store, intent.clientOrderId);
    store.transition(intent.clientOrderId, "CANCEL_PENDING", "cancel_requested");
    expect(store.applyBrokerEvent(ev(intent.clientOrderId, { kind: "cancel_ack" })).state).toBe("CANCELED");
    const late = store.applyBrokerEvent(ev(intent.clientOrderId, { kind: "fill", qty: dec(100), price: dec("450"), cumulativeQty: dec(100), avgPrice: dec("450") }));
    expect(late.applied).toBe(false);
    expect(late.state).toBe("CANCELED");
    expect(late.reason).toBe("reconciliation_needed:terminal_state");
    const hist = store.history(intent.clientOrderId);
    const last = hist[hist.length - 1];
    expect(last?.reason).toBe("reconciliation_needed:fill:terminal_state");
    expect(last?.fromState).toBe("CANCELED");
    expect(last?.toState).toBe("CANCELED");
    // The filled quantity is not touched by an event that was not applied.
    expect(store.snapshot(intent.clientOrderId)?.filledQty.isZero()).toBe(true);
    expect(store.openOrders()).toHaveLength(0);
  });

  it("returns unknown_order for an event about an intent it never saw", () => {
    const store = newStore();
    const r = store.applyBrokerEvent(ev("ord_never_persisted", { kind: "ack", brokerOrderId: "bo_x" }));
    expect(r).toEqual({ applied: false, state: undefined, reason: "unknown_order", underProtected: false });
  });

  it("accumulates partial fills with a weighted average price", () => {
    const store = newStore();
    const intent = makeIntent();
    store.persistIntent(intent);
    ack(store, intent.clientOrderId);
    store.applyBrokerEvent(ev(intent.clientOrderId, { kind: "partial_fill", qty: dec(30), price: dec("450.00"), cumulativeQty: dec(30), avgPrice: dec("450.00") }));
    store.applyBrokerEvent(ev(intent.clientOrderId, { kind: "fill", qty: dec(70), price: dec("451.00"), cumulativeQty: dec(100), avgPrice: dec("450.70") }));
    const snap = store.snapshot(intent.clientOrderId);
    expect(snap?.state).toBe("FILLED");
    expect(snap?.filledQty.eq(dec(100))).toBe(true);
    expect(snap?.avgFillPrice?.toFixed(2)).toBe("450.70");
  });

  it("reconciles UNKNOWN from a broker event, tagging the transition as reconciliation", () => {
    const store = newStore();
    const intent = makeIntent();
    store.persistIntent(intent);
    store.transition(intent.clientOrderId, "VALIDATED", "t");
    store.transition(intent.clientOrderId, "APPROVED", "t");
    store.transition(intent.clientOrderId, "SUBMITTING", "t");
    store.transition(intent.clientOrderId, "UNKNOWN", "submit_response_lost");
    const r = store.applyBrokerEvent(ev(intent.clientOrderId, { kind: "ack", brokerOrderId: "bo_late" }, "evt_late", utc("2026-09-08T14:31:00Z")));
    expect(r).toMatchObject({ applied: true, state: "ACKNOWLEDGED", reason: "reconciliation:broker_event:ack" });
    expect(store.snapshot(intent.clientOrderId)?.brokerOrderId).toBe("bo_late");
  });
});
