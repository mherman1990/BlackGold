import {
  Dec,
  ZERO,
  dec,
  decToString,
  migrate,
  nowUtc,
  utc,
  type Db,
  type Migration,
  type OrderState,
  type UtcInstant,
} from "@blackgold/shared";
import type { BrokerEvent, BrokerOrderSnapshot, OrderIntent } from "../types.ts";
import { DuplicateIntentError, UnknownOrderError } from "../errors.ts";
import { IllegalTransitionError, assertTransition, isLegalTransition, isTerminal } from "./transitions.ts";
import { intentFromJson, intentToJson } from "./intent-codec.ts";

/**
 * Persisted, event-sourced order lifecycle. Every state change is a row in the append-only
 * `order_transitions` log (RAISE triggers block UPDATE/DELETE) plus an atomic update of `order_states`.
 * Broker events are idempotent by event id via `broker_events_seen`.
 */
export const ORDER_STORE_MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_order_intents",
    up: `
      CREATE TABLE order_intents (
        intent_id TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL UNIQUE,
        sleeve_account_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity TEXT NOT NULL,
        order_type TEXT NOT NULL,
        limit_price TEXT,
        time_in_force TEXT NOT NULL,
        protection_json TEXT,
        quote_json TEXT NOT NULL,
        risk_snapshot_hash TEXT NOT NULL,
        authorization_ref TEXT,
        created_at TEXT NOT NULL,
        intent_json TEXT NOT NULL
      );`,
  },
  {
    id: "0002_order_states",
    up: `
      CREATE TABLE order_states (
        client_order_id TEXT PRIMARY KEY REFERENCES order_intents(client_order_id),
        state TEXT NOT NULL,
        filled_qty TEXT NOT NULL,
        avg_fill_price TEXT,
        protection_confirmed_qty TEXT NOT NULL,
        broker_order_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX order_states_state ON order_states(state);`,
  },
  {
    id: "0003_order_transitions_append_only",
    up: `
      CREATE TABLE order_transitions (
        id INTEGER PRIMARY KEY,
        client_order_id TEXT NOT NULL REFERENCES order_intents(client_order_id),
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        event_json TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX order_transitions_order ON order_transitions(client_order_id, id);
      CREATE TRIGGER order_transitions_no_update BEFORE UPDATE ON order_transitions
        BEGIN SELECT RAISE(ABORT, 'order_transitions is append-only'); END;
      CREATE TRIGGER order_transitions_no_delete BEFORE DELETE ON order_transitions
        BEGIN SELECT RAISE(ABORT, 'order_transitions is append-only'); END;`,
  },
  {
    id: "0004_broker_events_seen",
    up: `
      CREATE TABLE broker_events_seen (
        event_id TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL,
        at TEXT NOT NULL
      );`,
  },
];

export type StatePatch = { filledQty?: Dec; avgFillPrice?: Dec; protectionConfirmedQty?: Dec; brokerOrderId?: string };

export type TransitionOptions = { event?: BrokerEvent; patch?: StatePatch; at?: UtcInstant };

export type ApplyEventResult = {
  applied: boolean;
  /** State after processing (undefined only when the order is not persisted at all). */
  state: OrderState | undefined;
  reason: string;
  /** True when a protection_ack covered less than the filled quantity; the order stays PROTECTION_PENDING. */
  underProtected: boolean;
};

export type TransitionRecord = {
  id: number;
  clientOrderId: string;
  fromState: OrderState | undefined;
  toState: OrderState;
  reason: string;
  at: UtcInstant;
};

type Row = Record<string, null | number | bigint | string | Uint8Array>;

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new TypeError(`column ${key} is not text`);
  return v;
}
function optStr(row: Row, key: string): string | undefined {
  const v = row[key];
  return typeof v === "string" ? v : undefined;
}
function asState(s: string): OrderState {
  return s as OrderState;
}

export class OrderStore {
  readonly db: Db;
  readonly clock: () => UtcInstant;

  constructor(db: Db, clock: () => UtcInstant = () => nowUtc()) {
    this.db = db;
    this.clock = clock;
    migrate(db, ORDER_STORE_MIGRATIONS);
  }

  /** Persist the validated intent as CREATED. Must run BEFORE any network side effect. */
  persistIntent(intent: OrderIntent, at: UtcInstant = this.clock()): void {
    this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT 1 AS x FROM order_intents WHERE client_order_id = ? OR intent_id = ?")
        .get(intent.clientOrderId, intent.intentId);
      if (existing) throw new DuplicateIntentError(intent.clientOrderId);
      this.db
        .prepare(
          `INSERT INTO order_intents (intent_id, client_order_id, sleeve_account_id, mode, strategy_id, strategy_version,
             symbol, side, quantity, order_type, limit_price, time_in_force, protection_json, quote_json,
             risk_snapshot_hash, authorization_ref, created_at, intent_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intent.intentId,
          intent.clientOrderId,
          intent.sleeveAccountId,
          intent.mode,
          intent.strategyId,
          intent.strategyVersion,
          intent.symbol,
          intent.side,
          decToString(intent.quantity),
          intent.orderType,
          intent.limitPrice === undefined ? null : decToString(intent.limitPrice),
          intent.timeInForce,
          intent.protection
            ? JSON.stringify({ stopPrice: decToString(intent.protection.stopPrice), construct: intent.protection.construct })
            : null,
          JSON.stringify({
            bid: decToString(intent.quote.bid),
            ask: decToString(intent.quote.ask),
            venue: intent.quote.venue,
            at: intent.quote.at,
          }),
          intent.riskSnapshotHash,
          intent.authorizationRef ?? null,
          intent.createdAt,
          intentToJson(intent),
        );
      this.db
        .prepare(
          `INSERT INTO order_states (client_order_id, state, filled_qty, avg_fill_price, protection_confirmed_qty, broker_order_id, updated_at)
           VALUES (?, 'CREATED', '0', NULL, '0', NULL, ?)`,
        )
        .run(intent.clientOrderId, at);
      this.appendTransition(intent.clientOrderId, undefined, "CREATED", "intent_persisted", undefined, at);
    });
  }

  intent(clientOrderId: string): OrderIntent | undefined {
    const row = this.db.prepare("SELECT intent_json FROM order_intents WHERE client_order_id = ?").get(clientOrderId);
    return row ? intentFromJson(str(row, "intent_json")) : undefined;
  }

  /** Assert legality (table + side conditions), then write the transition row and the new state atomically. */
  transition(clientOrderId: string, to: OrderState, reason: string, opts: TransitionOptions = {}): BrokerOrderSnapshot {
    return this.db.transaction(() => this.transitionInTx(clientOrderId, to, reason, opts));
  }

  /**
   * Apply a broker event exactly once. A duplicate event id is ignored. An event whose implied transition is
   * illegal for the current state (for example a fill after cancel_ack on a terminal order) is recorded as a
   * `reconciliation_needed` attempt in the transition log and returns applied:false instead of throwing.
   */
  applyBrokerEvent(event: BrokerEvent, at: UtcInstant = this.clock()): ApplyEventResult {
    return this.db.transaction(() => {
      const seen = this.db.prepare("SELECT 1 AS x FROM broker_events_seen WHERE event_id = ?").get(event.eventId);
      const current = this.snapshot(event.clientOrderId);
      if (seen) return { applied: false, state: current?.state, reason: "duplicate_event", underProtected: false };
      this.db
        .prepare("INSERT INTO broker_events_seen (event_id, client_order_id, at) VALUES (?, ?, ?)")
        .run(event.eventId, event.clientOrderId, at);
      if (!current) return { applied: false, state: undefined, reason: "unknown_order", underProtected: false };
      return this.applyInTx(current, event, at);
    });
  }

  snapshot(clientOrderId: string): BrokerOrderSnapshot | undefined {
    const row = this.db.prepare("SELECT * FROM order_states WHERE client_order_id = ?").get(clientOrderId);
    return row ? rowToSnapshot(row) : undefined;
  }

  /** Orders in any non-terminal state. Survives restarts because it is read from SQLite, not memory. */
  openOrders(): BrokerOrderSnapshot[] {
    return this.db
      .prepare("SELECT * FROM order_states WHERE state NOT IN ('CLOSED','CANCELED','REJECTED') ORDER BY updated_at, client_order_id")
      .all()
      .map(rowToSnapshot);
  }

  history(clientOrderId: string): TransitionRecord[] {
    return this.db
      .prepare("SELECT id, client_order_id, from_state, to_state, reason, at FROM order_transitions WHERE client_order_id = ? ORDER BY id")
      .all(clientOrderId)
      .map((r) => ({
        id: Number(r["id"]),
        clientOrderId: str(r, "client_order_id"),
        fromState: optStr(r, "from_state") === undefined ? undefined : asState(str(r, "from_state")),
        toState: asState(str(r, "to_state")),
        reason: str(r, "reason"),
        at: utc(str(r, "at")),
      }));
  }

  // ---- internals (must be called inside a transaction) ----

  private transitionInTx(clientOrderId: string, to: OrderState, reason: string, opts: TransitionOptions): BrokerOrderSnapshot {
    const current = this.snapshot(clientOrderId);
    if (!current) throw new UnknownOrderError(clientOrderId);
    const from = current.state;
    assertTransition(from, to);
    if (from === "UNKNOWN" && !reason.startsWith("reconciliation:")) {
      throw new IllegalTransitionError(from, to, "UNKNOWN exits only through reconciliation against broker truth");
    }
    if (from === "FILLED" && to === "CLOSED") {
      const intent = this.intent(clientOrderId);
      if (intent?.side !== "SELL") throw new IllegalTransitionError(from, to, "only an exit (SELL) closes from FILLED");
    }
    const at = opts.at ?? this.clock();
    this.patchState(clientOrderId, to, opts.patch ?? {}, at);
    this.appendTransition(clientOrderId, from, to, reason, opts.event, at);
    const next = this.snapshot(clientOrderId);
    if (!next) throw new UnknownOrderError(clientOrderId);
    return next;
  }

  private applyInTx(current: BrokerOrderSnapshot, event: BrokerEvent, at: UtcInstant): ApplyEventResult {
    const id = current.clientOrderId;
    const from = current.state;
    const reason = `broker_event:${event.kind}`;
    const reconciled = from === "UNKNOWN" ? `reconciliation:${reason}` : reason;

    const attempt = (to: OrderState, patch: StatePatch = {}): ApplyEventResult => {
      if (!isLegalTransition(from, to) || (from === "FILLED" && to === "CLOSED")) {
        const why = isTerminal(from) ? "terminal_state" : "illegal_for_state";
        this.appendTransition(id, from, from, `reconciliation_needed:${event.kind}:${why}`, event, at);
        return { applied: false, state: from, reason: `reconciliation_needed:${why}`, underProtected: false };
      }
      this.patchState(id, to, patch, at);
      this.appendTransition(id, from, to, reconciled, event, at);
      return { applied: true, state: to, reason: reconciled, underProtected: false };
    };
    const noop = (why: string, patch: StatePatch = {}): ApplyEventResult => {
      this.patchState(id, from, patch, at);
      this.appendTransition(id, from, from, `noop:${event.kind}:${why}`, event, at);
      return { applied: false, state: from, reason: `noop:${why}`, underProtected: false };
    };

    switch (event.kind) {
      case "ack":
        if (from === "ACKNOWLEDGED") return noop("already_acknowledged", { brokerOrderId: event.brokerOrderId });
        // An ack that arrives after fills (out-of-order delivery) is stale, not a reconciliation problem.
        if (from !== "SUBMITTING" && from !== "UNKNOWN") return noop("stale_ack", { brokerOrderId: event.brokerOrderId });
        return attempt("ACKNOWLEDGED", { brokerOrderId: event.brokerOrderId });
      case "reject":
        return attempt("REJECTED");
      case "partial_fill": {
        if (isStaleFill(current, event.cumulativeQty)) return noop("stale_fill_event");
        return attempt("PARTIALLY_FILLED", fillPatch(event));
      }
      case "fill": {
        if (isStaleFill(current, event.cumulativeQty)) return noop("stale_fill_event");
        const filled = attempt("FILLED", fillPatch(event));
        if (!filled.applied) return filled;
        // A filled entry with requested protection is not done: it awaits broker confirmation of coverage.
        const intent = this.intent(id);
        if (intent?.protection && intent.side === "BUY") {
          this.patchState(id, "PROTECTION_PENDING", {}, at);
          this.appendTransition(id, "FILLED", "PROTECTION_PENDING", "protection_requested", undefined, at);
          return { ...filled, state: "PROTECTION_PENDING" };
        }
        return filled;
      }
      case "cancel_ack":
        return attempt("CANCELED");
      case "protection_ack": {
        if (from !== "PROTECTION_PENDING") return attempt("PROTECTED", { protectionConfirmedQty: event.coveredQty });
        const patch = { protectionConfirmedQty: event.coveredQty };
        if (event.coveredQty.gte(current.filledQty) && current.filledQty.gt(ZERO)) return attempt("PROTECTED", patch);
        return { ...noop("under_protected", patch), underProtected: true };
      }
      case "protection_reject":
        return attempt("PROTECTION_FAILED");
      case "unknown_timeout":
        if (from === "UNKNOWN") return noop("already_unknown");
        return attempt("UNKNOWN");
    }
  }

  private patchState(clientOrderId: string, state: OrderState, patch: StatePatch, at: UtcInstant): void {
    this.db
      .prepare(
        `UPDATE order_states SET state = ?, updated_at = ?,
           filled_qty = COALESCE(?, filled_qty),
           avg_fill_price = COALESCE(?, avg_fill_price),
           protection_confirmed_qty = COALESCE(?, protection_confirmed_qty),
           broker_order_id = COALESCE(?, broker_order_id)
         WHERE client_order_id = ?`,
      )
      .run(
        state,
        at,
        patch.filledQty === undefined ? null : decToString(patch.filledQty),
        patch.avgFillPrice === undefined ? null : decToString(patch.avgFillPrice),
        patch.protectionConfirmedQty === undefined ? null : decToString(patch.protectionConfirmedQty),
        patch.brokerOrderId ?? null,
        clientOrderId,
      );
  }

  private appendTransition(
    clientOrderId: string,
    from: OrderState | undefined,
    to: OrderState,
    reason: string,
    event: BrokerEvent | undefined,
    at: UtcInstant,
  ): void {
    this.db
      .prepare(
        "INSERT INTO order_transitions (client_order_id, from_state, to_state, reason, event_json, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(clientOrderId, from ?? null, to, reason, event ? eventToJson(event) : null, at);
  }
}

/** Broker truth wins: the persisted totals come from the event's cumulative fields, never from summing deltas. */
function fillPatch(event: { cumulativeQty: Dec; avgPrice: Dec }): StatePatch {
  return { filledQty: event.cumulativeQty, avgFillPrice: event.avgPrice };
}

/** A fill event whose cumulative quantity does not exceed what we already hold arrived late or twice. */
function isStaleFill(current: BrokerOrderSnapshot, cumulativeQty: Dec): boolean {
  return current.filledQty.gt(ZERO) && cumulativeQty.lte(current.filledQty);
}

function rowToSnapshot(row: Row): BrokerOrderSnapshot {
  const snap: BrokerOrderSnapshot = {
    clientOrderId: str(row, "client_order_id"),
    state: asState(str(row, "state")),
    filledQty: dec(str(row, "filled_qty")),
    protectionConfirmedQty: dec(str(row, "protection_confirmed_qty")),
    lastEventAt: utc(str(row, "updated_at")),
  };
  const broker = optStr(row, "broker_order_id");
  if (broker !== undefined) snap.brokerOrderId = broker;
  const avg = optStr(row, "avg_fill_price");
  if (avg !== undefined) snap.avgFillPrice = dec(avg);
  return snap;
}

/** Events are logged with decimals as strings; nothing secret lives in a BrokerEvent. */
function eventToJson(event: BrokerEvent): string {
  return JSON.stringify(event, (_k, v: unknown) => (v instanceof Dec ? v.toFixed() : v));
}
