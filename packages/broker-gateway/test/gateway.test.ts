import { describe, expect, it } from "vitest";
import { addMs, dec, openDatabase } from "@blackgold/shared";
import {
  AccountBoundaryViolation,
  AllowlistConfigError,
  DuplicateIntentError,
  Gateway,
  OrderStore,
  SleeveAllowlist,
  SyntheticBroker,
  type BrokerTradingAdapter,
  type FaultPlan,
} from "../src/index.ts";
import { OTHER, SLEEVE, T0, makeCaps, makeIntent, makeRig, pump, tempDbPath } from "./helpers.ts";

const fills30_70: FaultPlan["fills"] = [
  { qty: dec(30), price: dec("450.00") },
  { qty: dec(70), price: dec("450.10") },
];
const protection = { stopPrice: dec("440.00"), construct: "NATIVE_BRACKET" as const };

describe("Gateway.submit fault suite (onSubmit)", () => {
  it("ack -> ACKNOWLEDGED with the broker order id; the ack event is then a no-op", async () => {
    const rig = makeRig();
    const intent = makeIntent();
    const r = await rig.gateway.submit(intent, T0);
    expect(r.state).toBe("ACKNOWLEDGED");
    expect(r.brokerOrderId).toMatch(/^bo_/);
    expect(rig.store.snapshot(intent.clientOrderId)?.brokerOrderId).toBe(r.brokerOrderId);
    const results = pump(rig);
    expect(results.map((x) => x.reason)).toEqual(["noop:already_acknowledged"]);
    expect(rig.store.history(intent.clientOrderId).map((t) => t.toState)).toEqual([
      "CREATED",
      "VALIDATED",
      "APPROVED",
      "SUBMITTING",
      "ACKNOWLEDGED",
      "ACKNOWLEDGED",
    ]);
  });

  it("reject -> REJECTED with BROKER_REJECTED", async () => {
    const rig = makeRig();
    const intent = makeIntent();
    rig.broker.plan(intent.clientOrderId, { onSubmit: "reject" });
    const r = await rig.gateway.submit(intent, T0);
    expect(r).toMatchObject({ state: "REJECTED", reasonCodes: ["BROKER_REJECTED"] });
    expect(rig.broker.orderCount()).toBe(0);
    expect(rig.store.openOrders()).toHaveLength(0);
  });

  it("timeout (broker never received) -> UNKNOWN; not found within grace stays UNKNOWN; after grace -> REJECTED + halt", async () => {
    const rig = makeRig({ unknownGraceMs: 60_000 });
    const intent = makeIntent();
    rig.broker.plan(intent.clientOrderId, { onSubmit: "timeout" });
    const r = await rig.gateway.submit(intent, T0);
    expect(r).toMatchObject({ state: "UNKNOWN", reasonCodes: ["SUBMIT_RESPONSE_LOST"] });

    const early = await rig.gateway.reconcile(intent.clientOrderId, addMs(T0, 59_999));
    expect(early).toMatchObject({ state: "UNKNOWN", changed: false, haltNewRisk: false, reason: "not_found_within_grace" });

    const late = await rig.gateway.reconcile(intent.clientOrderId, addMs(T0, 60_000));
    expect(late).toMatchObject({ before: "UNKNOWN", state: "REJECTED", changed: true, haltNewRisk: true, reason: "NOT_FOUND_AFTER_UNKNOWN" });
    expect(rig.store.snapshot(intent.clientOrderId)?.state).toBe("REJECTED");
    expect(rig.broker.orderCount()).toBe(0);
    expect(rig.broker.submitCallCount()).toBe(1);
  });

  it("ack_after_timeout -> UNKNOWN, reconcile -> ACKNOWLEDGED, and exactly one broker order exists", async () => {
    const rig = makeRig();
    const intent = makeIntent();
    rig.broker.plan(intent.clientOrderId, { onSubmit: "ack_after_timeout" });
    const r = await rig.gateway.submit(intent, T0);
    expect(r.state).toBe("UNKNOWN");
    expect(rig.broker.orderCount()).toBe(1);

    const rec = await rig.gateway.reconcile(intent.clientOrderId, addMs(T0, 1_000));
    expect(rec).toMatchObject({ before: "UNKNOWN", state: "ACKNOWLEDGED", changed: true, haltNewRisk: false });
    const snap = rig.store.snapshot(intent.clientOrderId);
    expect(snap?.state).toBe("ACKNOWLEDGED");
    expect(snap?.brokerOrderId).toMatch(/^bo_/);

    // No blind retry happened, and a caller that tries to resubmit is stopped by the store.
    expect(rig.broker.orderCount()).toBe(1);
    expect(rig.broker.submitCallCount()).toBe(1);
    await expect(rig.gateway.submit(intent, T0)).rejects.toThrow(DuplicateIntentError);
    expect(rig.broker.orderCount()).toBe(1);

    // The late ack event is a no-op now, not a second acknowledgement.
    expect(pump(rig).map((x) => x.reason)).toEqual(["noop:already_acknowledged"]);
    const again = await rig.gateway.reconcile(intent.clientOrderId, addMs(T0, 2_000));
    expect(again).toMatchObject({ changed: false, reason: "not_unknown" });
  });

  it("adapter throwing after persist leaves the intent row and marks UNKNOWN (never retries)", async () => {
    let calls = 0;
    const throwing: BrokerTradingAdapter = {
      allowedAccountId: SLEEVE,
      submit: () => {
        calls++;
        return Promise.reject(new Error("ECONNRESET"));
      },
      orderStatus: () => Promise.resolve(undefined),
      cancel: () => Promise.resolve("UNKNOWN"),
      openOrders: () => Promise.resolve([]),
      positions: () => Promise.resolve([]),
    };
    const store = new OrderStore(openDatabase(":memory:"), () => T0);
    const gateway = new Gateway({ allowlist: new SleeveAllowlist(SLEEVE), caps: makeCaps(), store, adapter: throwing, unknownGraceMs: 1 });
    const intent = makeIntent();
    const r = await gateway.submit(intent, T0);
    expect(r).toMatchObject({ state: "UNKNOWN", reasonCodes: ["ADAPTER_ERROR"] });
    expect(store.intent(intent.clientOrderId)?.clientOrderId).toBe(intent.clientOrderId);
    expect(store.snapshot(intent.clientOrderId)?.state).toBe("UNKNOWN");
    expect(calls).toBe(1);
  });
});

describe("Gateway guards", () => {
  it("rejects a non-sleeve account before any broker call and raises", async () => {
    const rig = makeRig();
    const intent = makeIntent({ sleeveAccountId: OTHER });
    await expect(rig.gateway.submit(intent, T0)).rejects.toThrow(AccountBoundaryViolation);
    expect(rig.store.snapshot(intent.clientOrderId)?.state).toBe("REJECTED");
    expect(rig.broker.submitCallCount()).toBe(0);
    expect(rig.store.history(intent.clientOrderId).map((t) => t.reason)).toEqual(["intent_persisted", "guard:ACCOUNT_MISMATCH"]);
  });

  it("rejects every live mode without touching the adapter", async () => {
    for (const mode of ["LIVE_MANUAL", "LIVE_LIMITED"] as const) {
      const rig = makeRig();
      const intent = makeIntent({ mode, authorizationRef: "auth_fixture" });
      const r = await rig.gateway.submit(intent, T0);
      expect(r.state, mode).toBe("REJECTED");
      expect(r.reasonCodes, mode).toContain("LIVE_UNAVAILABLE");
      expect(rig.broker.submitCallCount(), mode).toBe(0);
    }
  });

  it("rejects a client order id that does not match the deterministic derivation", async () => {
    const rig = makeRig();
    const intent = makeIntent({ clientOrderId: "ord_forged_00000000000000000000000000" });
    const r = await rig.gateway.submit(intent, T0);
    expect(r).toMatchObject({ state: "REJECTED", reasonCodes: ["CLIENT_ORDER_ID_MISMATCH"] });
    expect(rig.broker.submitCallCount()).toBe(0);
  });

  it("records hard-cap rejections with their reason codes", async () => {
    const rig = makeRig();
    const intent = makeIntent({ quantity: dec(501) });
    const r = await rig.gateway.submit(intent, T0);
    expect(r.state).toBe("REJECTED");
    expect(r.reasonCodes).toEqual(["QTY_CAP", "NOTIONAL_CAP"]);
    expect(rig.broker.submitCallCount()).toBe(0);
  });

  it("refuses to compose components that disagree about the sleeve account", () => {
    const store = new OrderStore(openDatabase(":memory:"), () => T0);
    const otherBroker = new SyntheticBroker({ allowedAccountId: OTHER });
    expect(
      () => new Gateway({ allowlist: new SleeveAllowlist(SLEEVE), caps: makeCaps(), store, adapter: otherBroker, unknownGraceMs: 1 }),
    ).toThrow(AllowlistConfigError);
    const broker = new SyntheticBroker({ allowedAccountId: SLEEVE });
    expect(
      () =>
        new Gateway({
          allowlist: new SleeveAllowlist(SLEEVE),
          caps: makeCaps({ sleeveAccountId: OTHER }),
          store,
          adapter: broker,
          unknownGraceMs: 1,
        }),
    ).toThrow(AllowlistConfigError);
  });

  it("the synthetic broker itself refuses a non-sleeve intent (belt and braces)", async () => {
    const broker = new SyntheticBroker({ allowedAccountId: SLEEVE });
    await expect(Promise.resolve().then(() => broker.submit(makeIntent({ sleeveAccountId: OTHER })))).rejects.toThrow(
      AccountBoundaryViolation,
    );
    expect(broker.orderCount()).toBe(0);
  });
});

describe("Gateway fills, protection, cancel", () => {
  it("partial fills 30 + 70 reach FILLED with a weighted average", async () => {
    const rig = makeRig();
    const intent = makeIntent();
    rig.broker.plan(intent.clientOrderId, { onSubmit: "ack", fills: fills30_70 });
    await rig.gateway.submit(intent, T0);
    const results = pump(rig);
    expect(results.map((x) => x.state)).toEqual(["ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED"]);
    const snap = rig.store.snapshot(intent.clientOrderId);
    expect(snap?.state).toBe("FILLED");
    expect(snap?.filledQty.eq(dec(100))).toBe(true);
    expect(snap?.avgFillPrice?.toFixed(3)).toBe("450.070");
    expect(rig.store.openOrders().map((o) => o.state)).toEqual(["FILLED"]);
  });

  it("a protected entry fills into PROTECTION_PENDING and becomes PROTECTED when coverage equals the filled qty", async () => {
    const rig = makeRig();
    const intent = makeIntent({ protection });
    rig.broker.plan(intent.clientOrderId, { onSubmit: "ack", fills: fills30_70, protection: "ack" });
    await rig.gateway.submit(intent, T0);
    const results = pump(rig);
    expect(results.map((x) => x.state)).toEqual(["ACKNOWLEDGED", "PARTIALLY_FILLED", "PROTECTION_PENDING", "PROTECTED"]);
    expect(results.every((x) => !x.underProtected)).toBe(true);
    const snap = rig.store.snapshot(intent.clientOrderId);
    expect(snap?.state).toBe("PROTECTED");
    expect(snap?.protectionConfirmedQty.eq(dec(100))).toBe(true);
    expect(rig.store.history(intent.clientOrderId).map((t) => t.reason)).toContain("protection_requested");
  });

  it("partial protection leaves PROTECTION_PENDING and reports underProtected", async () => {
    const rig = makeRig();
    const intent = makeIntent({ protection });
    rig.broker.plan(intent.clientOrderId, { onSubmit: "ack", fills: [{ qty: dec(100), price: dec("450") }], protection: "partial" });
    await rig.gateway.submit(intent, T0);
    const results = pump(rig);
    const last = results[results.length - 1];
    expect(last).toMatchObject({ applied: false, state: "PROTECTION_PENDING", underProtected: true });
    const snap = rig.store.snapshot(intent.clientOrderId);
    expect(snap?.state).toBe("PROTECTION_PENDING");
    expect(snap?.protectionConfirmedQty.eq(dec(50))).toBe(true);
    expect(snap?.filledQty.eq(dec(100))).toBe(true);
  });

  it("protection reject -> PROTECTION_FAILED", async () => {
    const rig = makeRig();
    const intent = makeIntent({ protection });
    rig.broker.plan(intent.clientOrderId, { onSubmit: "ack", fills: [{ qty: dec(100), price: dec("450") }], protection: "reject" });
    await rig.gateway.submit(intent, T0);
    const results = pump(rig);
    expect(results.map((x) => x.state)).toEqual(["ACKNOWLEDGED", "PROTECTION_PENDING", "PROTECTION_FAILED"]);
    expect(rig.store.snapshot(intent.clientOrderId)?.state).toBe("PROTECTION_FAILED");
  });

  it("an unprotected SELL exit fills to FILLED, not PROTECTION_PENDING", async () => {
    const rig = makeRig();
    const intent = makeIntent({ side: "SELL" });
    rig.broker.plan(intent.clientOrderId, { onSubmit: "ack", fills: [{ qty: dec(100), price: dec("450") }] });
    await rig.gateway.submit(intent, T0);
    pump(rig);
    expect(rig.store.snapshot(intent.clientOrderId)?.state).toBe("FILLED");
    expect(rig.store.transition(intent.clientOrderId, "CLOSED", "exit_complete").state).toBe("CLOSED");
  });

  it("cancel race: a fill arriving during CANCEL_PENDING wins and the order is FILLED", async () => {
    const rig = makeRig();
    const intent = makeIntent();
    rig.broker.plan(intent.clientOrderId, { onSubmit: "ack", cancel: "race_fill" });
    await rig.gateway.submit(intent, T0);
    pump(rig);
    const pending = await rig.gateway.cancel(intent.clientOrderId, T0);
    expect(pending.state).toBe("CANCEL_PENDING");
    const results = pump(rig);
    expect(results.map((x) => x.state)).toEqual(["FILLED"]);
    const snap = rig.store.snapshot(intent.clientOrderId);
    expect(snap?.state).toBe("FILLED");
    expect(snap?.filledQty.eq(dec(100))).toBe(true);
  });

  it("cancel ack -> CANCELED; cancel timeout -> UNKNOWN then reconciled from broker truth", async () => {
    const rig = makeRig();
    const a = makeIntent({ intentId: "intent_cancel_ack" });
    const b = makeIntent({ intentId: "intent_cancel_timeout" });
    rig.broker.plan(a.clientOrderId, { onSubmit: "ack", cancel: "ack" });
    rig.broker.plan(b.clientOrderId, { onSubmit: "ack", cancel: "timeout" });
    await rig.gateway.submit(a, T0);
    await rig.gateway.submit(b, T0);
    pump(rig);

    await rig.gateway.cancel(a.clientOrderId, T0);
    pump(rig);
    expect(rig.store.snapshot(a.clientOrderId)?.state).toBe("CANCELED");

    const bSnap = await rig.gateway.cancel(b.clientOrderId, T0);
    expect(bSnap.state).toBe("UNKNOWN");
    const rec = await rig.gateway.reconcile(b.clientOrderId, addMs(T0, 1));
    expect(rec.state).toBe("ACKNOWLEDGED"); // broker still holds it open; the cancel never landed
    expect(rig.store.openOrders().map((o) => o.clientOrderId)).toEqual([b.clientOrderId]);
  });

  it("cancel before submission is local and never reaches the broker", async () => {
    const rig = makeRig();
    const intent = makeIntent();
    rig.store.persistIntent(intent);
    rig.store.transition(intent.clientOrderId, "VALIDATED", "t");
    rig.store.transition(intent.clientOrderId, "AWAITING_APPROVAL", "t");
    const snap = await rig.gateway.cancel(intent.clientOrderId, T0);
    expect(snap.state).toBe("CANCELED");
    expect(rig.broker.orderCount()).toBe(0);
  });
});

describe("Gateway idempotency and ordering", () => {
  it("duplicate events are ignored: 30 + 70 delivered twice still fills exactly 100", async () => {
    const rig = makeRig();
    const intent = makeIntent();
    rig.broker.plan(intent.clientOrderId, { onSubmit: "ack", fills: fills30_70, duplicateEvents: true });
    await rig.gateway.submit(intent, T0);
    const results = pump(rig);
    expect(results).toHaveLength(6);
    expect(results.filter((x) => x.reason === "duplicate_event")).toHaveLength(3);
    const snap = rig.store.snapshot(intent.clientOrderId);
    expect(snap?.state).toBe("FILLED");
    expect(snap?.filledQty.eq(dec(100))).toBe(true);
  });

  it("out-of-order events never throw; the unexplained ones are flagged for reconciliation", async () => {
    const rig = makeRig();
    const intent = makeIntent();
    rig.broker.plan(intent.clientOrderId, { onSubmit: "ack", fills: fills30_70, outOfOrder: true });
    await rig.gateway.submit(intent, T0);
    const results = pump(rig); // fill(70), partial_fill(30), ack
    expect(results.map((x) => x.applied)).toEqual([true, false, false]);
    expect(results[1]?.reason).toBe("reconciliation_needed:illegal_for_state");
    const reasons = rig.store.history(intent.clientOrderId).map((t) => t.reason);
    expect(reasons.filter((r) => r.startsWith("reconciliation_needed:"))).toHaveLength(2);
    expect(rig.store.snapshot(intent.clientOrderId)?.state).toBe("FILLED");
  });

  it("restart: a new Gateway over the same database file sees the same state and open orders", async () => {
    const path = tempDbPath();
    const first = makeRig({ dbPath: path });
    const a = makeIntent({ intentId: "intent_restart_a" });
    const b = makeIntent({ intentId: "intent_restart_b" });
    first.broker.plan(a.clientOrderId, { onSubmit: "ack", fills: [{ qty: dec(30), price: dec("450") }] });
    first.broker.plan(b.clientOrderId, { onSubmit: "reject" });
    await first.gateway.submit(a, T0);
    await first.gateway.submit(b, T0);
    pump(first);
    const beforeSnap = first.store.snapshot(a.clientOrderId);
    const beforeOpen = first.store.openOrders();
    const beforeHistoryLength = first.store.history(a.clientOrderId).length;
    first.db.close();

    const second = makeRig({ dbPath: path });
    const afterSnap = second.store.snapshot(a.clientOrderId);
    expect(afterSnap).toBeDefined();
    expect(afterSnap?.state).toBe("PARTIALLY_FILLED");
    expect(afterSnap?.filledQty.eq(dec(30))).toBe(true);
    expect(afterSnap?.brokerOrderId).toBe(beforeSnap?.brokerOrderId);
    expect(second.store.snapshot(b.clientOrderId)?.state).toBe("REJECTED");
    expect(second.store.openOrders().map((o) => o.clientOrderId)).toEqual(beforeOpen.map((o) => o.clientOrderId));
    expect(second.store.openOrders()).toHaveLength(1);
    expect(second.store.history(a.clientOrderId).length).toBe(beforeHistoryLength);
    // Resubmitting a persisted intent after restart is still refused.
    await expect(second.gateway.submit(a, T0)).rejects.toThrow(DuplicateIntentError);
    second.db.close();
  });
});
