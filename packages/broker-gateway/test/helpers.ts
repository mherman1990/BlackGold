import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dec, openDatabase, sha256Hex, utc, type Db, type UtcInstant } from "@blackgold/shared";
import {
  Gateway,
  HardCaps,
  OrderStore,
  SleeveAllowlist,
  SyntheticBroker,
  clientOrderIdFor,
  type BrokerEvent,
  type HardCapConfig,
  type OrderIntent,
} from "../src/index.ts";

/** Sanitized fixtures only: these are not real account identifiers. */
export const SLEEVE = "SLEEVE-TEST-0001";
export const OTHER = "OTHER-TEST-0002";

export const T0: UtcInstant = utc("2026-09-08T14:30:00Z");
export const QUOTE_AT: UtcInstant = utc("2026-09-08T14:29:59Z");

/** Overrides may set a key to undefined to remove an optional field (e.g. limitPrice for MARKET orders). */
export type IntentOverrides = { [K in keyof OrderIntent]?: OrderIntent[K] | undefined };

export function makeIntent(overrides: IntentOverrides = {}): OrderIntent {
  const base: OrderIntent = {
    intentId: "intent_test_0001",
    clientOrderId: "",
    sleeveAccountId: SLEEVE,
    mode: "PAPER",
    strategyId: "etf-trend-vol",
    strategyVersion: "etf-trend-vol@1.0.0",
    symbol: "SPY",
    side: "BUY",
    quantity: dec(100),
    orderType: "LIMIT",
    limitPrice: dec("450.00"),
    timeInForce: "DAY",
    quote: { bid: dec("449.98"), ask: dec("450.02"), venue: "SYNTHETIC", at: QUOTE_AT },
    riskSnapshotHash: sha256Hex("risk-snapshot-fixture"),
    complianceVerdict: { ok: true, reasonCodes: [] },
    riskVerdict: { ok: true, reasonCodes: [] },
    decisionAt: T0,
    createdAt: T0,
  };
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v !== undefined) merged[k] = v;
  }
  const result = merged as unknown as OrderIntent;
  if (overrides.clientOrderId === undefined) result.clientOrderId = clientOrderIdFor(result);
  return result;
}


export function makeCaps(overrides: Partial<HardCapConfig> = {}): HardCaps {
  return new HardCaps({
    sleeveAccountId: SLEEVE,
    maxOrderNotional: dec("50000"),
    maxOrderQty: dec(500),
    allowedOrderTypes: ["LIMIT", "MARKET"],
    allowedTimeInForce: ["DAY"],
    allowedSides: ["BUY", "SELL"],
    maxQuoteAgeMs: 5_000,
    ...overrides,
  });
}

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "bg-gateway-")), "gateway.sqlite");
}

export type Rig = { db: Db; store: OrderStore; broker: SyntheticBroker; gateway: Gateway };

export function makeRig(opts: { dbPath?: string; broker?: SyntheticBroker; unknownGraceMs?: number } = {}): Rig {
  const db = openDatabase(opts.dbPath ?? ":memory:");
  const store = new OrderStore(db, () => T0);
  const broker = opts.broker ?? new SyntheticBroker({ allowedAccountId: SLEEVE, seed: "fixture", clock: () => T0 });
  const gateway = new Gateway({
    allowlist: new SleeveAllowlist(SLEEVE),
    caps: makeCaps(),
    store,
    adapter: broker,
    unknownGraceMs: opts.unknownGraceMs ?? 60_000,
  });
  return { db, store, broker, gateway };
}

/** Feed every drained broker event through the gateway, returning the per-event results. */
export function pump(rig: Rig): ReturnType<Gateway["onBrokerEvent"]>[] {
  return rig.broker.events().map((e: BrokerEvent) => rig.gateway.onBrokerEvent(e, T0));
}
