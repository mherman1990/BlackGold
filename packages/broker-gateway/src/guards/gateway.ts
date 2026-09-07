import { epochMs, type OrderState, type UtcInstant } from "@blackgold/shared";
import { AccountBoundaryViolation, AllowlistConfigError, UnknownOrderError } from "../errors.ts";
import type { BrokerEvent, BrokerOrderSnapshot, BrokerTradingAdapter, OrderIntent } from "../types.ts";
import { clientOrderIdFor } from "../state-machine/client-order-id.ts";
import { type ApplyEventResult, type OrderStore, type StatePatch } from "../state-machine/store.ts";
import type { HardCaps } from "./hard-caps.ts";
import type { SleeveAllowlist } from "./sleeve-allowlist.ts";

export type GatewayConfig = {
  allowlist: SleeveAllowlist;
  caps: HardCaps;
  store: OrderStore;
  adapter: BrokerTradingAdapter;
  /** How long an UNKNOWN order may be missing from broker truth before it is declared REJECTED and new risk halts. */
  unknownGraceMs: number;
};

export type SubmitResult = {
  clientOrderId: string;
  state: OrderState;
  reasonCodes: string[];
  brokerOrderId?: string;
};

export type ReconcileResult = {
  clientOrderId: string;
  before: OrderState;
  state: OrderState;
  changed: boolean;
  /** Fail closed: set when broker truth cannot account for an order we may have sent. */
  haltNewRisk: boolean;
  reason: string;
};

export type GatewayEventResult = ApplyEventResult;

/** States reconciliation may move an UNKNOWN order into, straight from broker truth. */
const RECONCILABLE: ReadonlySet<OrderState> = new Set<OrderState>([
  "ACKNOWLEDGED",
  "PARTIALLY_FILLED",
  "FILLED",
  "REJECTED",
  "CANCELED",
]);

/**
 * The only path from an OrderIntent to a broker call. Composes the sleeve allowlist, the hard caps, the persisted
 * state machine, and one BrokerTradingAdapter. Persists before it calls; never retries an UNKNOWN blindly.
 */
export class Gateway {
  readonly allowlist: SleeveAllowlist;
  readonly caps: HardCaps;
  readonly store: OrderStore;
  readonly adapter: BrokerTradingAdapter;
  readonly unknownGraceMs: number;

  constructor(cfg: GatewayConfig) {
    const sleeve = cfg.allowlist.allowedAccountId;
    if (cfg.adapter.allowedAccountId !== sleeve) throw new AllowlistConfigError("adapter account differs from allowlist");
    if (cfg.caps.config.sleeveAccountId !== sleeve) throw new AllowlistConfigError("hard-cap account differs from allowlist");
    if (cfg.unknownGraceMs <= 0) throw new RangeError("unknownGraceMs must be positive");
    this.allowlist = cfg.allowlist;
    this.caps = cfg.caps;
    this.store = cfg.store;
    this.adapter = cfg.adapter;
    this.unknownGraceMs = cfg.unknownGraceMs;
  }

  async submit(intent: OrderIntent, now: UtcInstant): Promise<SubmitResult> {
    const id = intent.clientOrderId;
    // 1. Persist first. Nothing below runs against an intent that is not already on disk.
    this.store.persistIntent(intent, now);

    // 2. Account boundary. A violation is recorded and then raised: it is a security event, not a soft reject.
    try {
      this.allowlist.assertSleeve(intent);
    } catch (err) {
      if (err instanceof AccountBoundaryViolation) {
        this.store.transition(id, "REJECTED", "guard:ACCOUNT_MISMATCH", { at: now });
      }
      throw err;
    }

    // 3. Every hard cap, plus the deterministic id itself.
    const reasonCodes: string[] = [];
    if (id !== clientOrderIdFor(intent)) reasonCodes.push("CLIENT_ORDER_ID_MISMATCH");
    reasonCodes.push(...this.caps.check(intent, now).reasonCodes);
    if (reasonCodes.length > 0) {
      this.store.transition(id, "REJECTED", `guard:${reasonCodes.join(",")}`, { at: now });
      return { clientOrderId: id, state: "REJECTED", reasonCodes };
    }
    this.store.transition(id, "VALIDATED", "guards_passed", { at: now });
    // Phase 0 handles non-live modes only; approval is implicit. Live approval arrives with the authorization verifier.
    this.store.transition(id, "APPROVED", intent.approval ? "approval_present" : "auto_approved:non_live_mode", { at: now });
    this.store.transition(id, "SUBMITTING", "submit", { at: now });

    // 4. One broker call. Any ambiguity is UNKNOWN; reconcile() is the only way out.
    let outcome;
    try {
      outcome = await this.adapter.submit(intent);
    } catch {
      this.store.transition(id, "UNKNOWN", "adapter_error", { at: now });
      return { clientOrderId: id, state: "UNKNOWN", reasonCodes: ["ADAPTER_ERROR"] };
    }
    if ("brokerOrderId" in outcome) {
      this.store.transition(id, "ACKNOWLEDGED", "broker_ack", { at: now, patch: { brokerOrderId: outcome.brokerOrderId } });
      return { clientOrderId: id, state: "ACKNOWLEDGED", reasonCodes: [], brokerOrderId: outcome.brokerOrderId };
    }
    if ("rejected" in outcome) {
      this.store.transition(id, "REJECTED", `broker_rejected:${outcome.rejected}`, { at: now });
      return { clientOrderId: id, state: "REJECTED", reasonCodes: ["BROKER_REJECTED"] };
    }
    this.store.transition(id, "UNKNOWN", "submit_response_lost", { at: now });
    return { clientOrderId: id, state: "UNKNOWN", reasonCodes: ["SUBMIT_RESPONSE_LOST"] };
  }

  /** Resolve an UNKNOWN order against broker truth. Never resubmits. */
  async reconcile(clientOrderId: string, now: UtcInstant): Promise<ReconcileResult> {
    const snap = this.store.snapshot(clientOrderId);
    if (!snap) throw new UnknownOrderError(clientOrderId);
    const before = snap.state;
    const unchanged = (reason: string, haltNewRisk: boolean): ReconcileResult => ({
      clientOrderId,
      before,
      state: before,
      changed: false,
      haltNewRisk,
      reason,
    });
    if (before !== "UNKNOWN") return unchanged("not_unknown", false);

    const broker = await this.adapter.orderStatus(clientOrderId);
    if (!broker) {
      const age = epochMs(now) - epochMs(snap.lastEventAt);
      if (age < this.unknownGraceMs) return unchanged("not_found_within_grace", false);
      this.store.transition(clientOrderId, "REJECTED", "reconciliation:NOT_FOUND_AFTER_UNKNOWN", { at: now });
      return { clientOrderId, before, state: "REJECTED", changed: true, haltNewRisk: true, reason: "NOT_FOUND_AFTER_UNKNOWN" };
    }
    if (!RECONCILABLE.has(broker.state)) return unchanged(`unclassified_broker_state:${broker.state}`, true);

    const patch: StatePatch = { filledQty: broker.filledQty, protectionConfirmedQty: broker.protectionConfirmedQty };
    if (broker.brokerOrderId !== undefined) patch.brokerOrderId = broker.brokerOrderId;
    if (broker.avgFillPrice !== undefined) patch.avgFillPrice = broker.avgFillPrice;
    let after = this.store.transition(clientOrderId, broker.state, "reconciliation:broker_status", { at: now, patch });
    if (after.state === "FILLED") after = this.requestProtectionIfNeeded(clientOrderId, now) ?? after;
    return { clientOrderId, before, state: after.state, changed: true, haltNewRisk: false, reason: "broker_status" };
  }

  /** Request a cancel. Before submission it is local; after, it is CANCEL_PENDING until the broker confirms. */
  async cancel(clientOrderId: string, now: UtcInstant): Promise<BrokerOrderSnapshot> {
    const snap = this.store.snapshot(clientOrderId);
    if (!snap) throw new UnknownOrderError(clientOrderId);
    if (snap.state === "AWAITING_APPROVAL" || snap.state === "APPROVED") {
      return this.store.transition(clientOrderId, "CANCELED", "cancel_before_submit", { at: now });
    }
    this.store.transition(clientOrderId, "CANCEL_PENDING", "cancel_requested", { at: now });
    let outcome: "CANCEL_PENDING" | "UNKNOWN";
    try {
      outcome = await this.adapter.cancel(clientOrderId);
    } catch {
      outcome = "UNKNOWN";
    }
    if (outcome === "UNKNOWN") return this.store.transition(clientOrderId, "UNKNOWN", "cancel_response_lost", { at: now });
    const after = this.store.snapshot(clientOrderId);
    if (!after) throw new UnknownOrderError(clientOrderId);
    return after;
  }

  /**
   * Apply one broker event idempotently. An entry becomes PROTECTED only when the confirmed coverage reaches the
   * filled quantity; a smaller coverage leaves it PROTECTION_PENDING and reports underProtected.
   */
  onBrokerEvent(event: BrokerEvent, now?: UtcInstant): GatewayEventResult {
    return this.store.applyBrokerEvent(event, now);
  }

  private requestProtectionIfNeeded(clientOrderId: string, now: UtcInstant): BrokerOrderSnapshot | undefined {
    const intent = this.store.intent(clientOrderId);
    if (!intent?.protection || intent.side !== "BUY") return undefined;
    return this.store.transition(clientOrderId, "PROTECTION_PENDING", "protection_requested", { at: now });
  }
}
