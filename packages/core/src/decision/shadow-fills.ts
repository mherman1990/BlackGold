import { Dec, ZERO, canonicalJson, sha256Hex, type Arm, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { shareTargets, rebalanceOrders } from "../strategy/construct.ts";
import { simulateFill, type SimBar } from "../research/simulator.ts";
import { costModelFor, type ResolvedCosts } from "../research/backtest.ts";
import type { ProspectiveDecisionRecord } from "./decision-record.ts";

/**
 * Counterfactual fills for sealed prospective decision records (D-53 slice 3b; AUTOMATION_AND_LIVE_GATES.md
 * SHADOW: "compute counterfactual fills with the internal simulator").
 *
 * A fill record is the OUTCOME of a sealed decision, produced strictly after it by the same deterministic
 * simulator the backtest uses (`simulateFill`): a decision made at the close of its decision session fills at
 * the open `delayBars` sessions later, adverse by the charter's cost model. The decision itself is never
 * touched - the sealed record is read-only input, and nothing here can change a weight, a gate verdict, or a
 * decision instant. No order, no account, no broker, no model (threat model T-05); the only "portfolio" is the
 * synthetic shadow book below.
 *
 * **The shadow book is synthetic.** It is denominated at {@link SHADOW_INITIAL_CASH} - the same arbitrary
 * research level `RESEARCH_INITIAL_CASH` uses - purely so whole-share sizing (`shareTargets` floors) has room
 * to work. It is not a household or sleeve dollar amount, carries no real money, and every reported ratio is
 * level-independent.
 *
 * **Gate verdicts bind the fills.** A record sealed with `newRiskAllowed: false` suppresses every order that
 * would INCREASE a position (entries and adds), exactly the HALT_NEW_RISK semantics: cancel entries, keep
 * exits. The suppressed entity ids are recorded on the fill record, so "what the gate prevented" is evidence,
 * not silence.
 *
 * **Known fidelity divergence from `runBacktest`, recorded here on purpose:** the backtest pre-caps each
 * order at a fraction of trailing ADV before handing it to the simulator. At the synthetic book's level the
 * per-bar participation cap inside `simulateFill` is the binding constraint and the ADV pre-cap can never
 * bind, so it is not duplicated here. If the synthetic level is ever raised to where it could bind, port the
 * pre-cap.
 */

export const SHADOW_FILL_RECORD_VERSION = 1;

/** Synthetic shadow-book denomination. Not a real dollar amount; ratios are level-independent. */
export const SHADOW_INITIAL_CASH = new Dec("100000");

/** One simulated fill, as persisted (all money as decimal strings - never binary float). */
export type ShadowFill = {
  session: IsoDate;
  entityId: string;
  side: "BUY" | "SELL";
  quantity: string;
  price: string;
  fees: string;
};

export type ShadowFillRecord = {
  recordVersion: number;
  strategyId: string;
  strategyVersion: string;
  /** The sealed decision this record fills, by its identity key and content hash. */
  charterHash: string;
  arm: Arm;
  decisionAt: UtcInstant;
  decisionSession: IsoDate;
  /** `record_hash` of the sealed decision record, binding the outcome to the exact sealed content. */
  decisionRecordHash: string;
  /** When this record was computed (>= every fill session's close). */
  computedAt: UtcInstant;
  /** The synthetic book's NAV and cash at the decision mark, as decimal strings of the synthetic unit. */
  navAtDecision: string;
  cashAtDecision: string;
  fills: ShadowFill[];
  /** Orders the gate suppressed (`newRiskAllowed: false` cancels entries/adds, keeps exits). */
  suppressedEntries: string[];
  /**
   * Orders with quantity left unfilled after the simulator's fill window, with why: `CASH` (whole-share
   * flooring plus an adverse open left the last shares unaffordable - the book's own arithmetic, expected),
   * `LIQUIDITY` (the simulator could not fill inside its window), or `NO_BARS` (no bars to simulate against).
   */
  unfilled: { entityId: string; side: "BUY" | "SELL"; remaining: string; reason: "CASH" | "LIQUIDITY" | "NO_BARS" }[];
  /** Target entities that could not be priced at the decision mark (no admissible bar). */
  unpriced: string[];
  /** Signed execution shortfall versus the decision close, fees included, in synthetic units. */
  executionShortfall: string;
  labels: string[];
};

export type ShadowBookState = {
  /** Whole-share positions keyed by entity id. */
  positions: ReadonlyMap<string, Dec>;
  cash: Dec;
  /** NAV marked at the decision session's closes. */
  nav: Dec;
};

export type CounterfactualFillInput = {
  record: ProspectiveDecisionRecord;
  /** `record_hash` of the sealed decision record (from the ledger row, never recomputed here). */
  decisionRecordHash: string;
  decisionSession: IsoDate;
  computedAt: UtcInstant;
  /** The shadow book at the decision mark, REPLAYED from prior fill records - never carried mutable state. */
  book: ShadowBookState;
  /** Session-ordered raw bars per entity, as of the computation instant. */
  bars: ReadonlyMap<string, readonly SimBar[]>;
  /** Raw closes at the decision session (the decision mark), per entity. */
  prices: ReadonlyMap<string, Dec>;
  costs: ResolvedCosts;
  /** The charter's rebalance band, in NAV percentage points. */
  bandPctPoints: Dec;
};

export const SHADOW_BOOK_NON_POSITIVE_NAV = "SHADOW_BOOK_NON_POSITIVE_NAV";

/**
 * Compute the counterfactual fills for one sealed decision record against the shadow book. Pure: every input
 * is passed in; it reads no config, clock, or database, and persists nothing. Deterministic for fixed inputs,
 * so the record is reproducible from the store.
 */
export function counterfactualFills(input: CounterfactualFillInput): ShadowFillRecord {
  const { record, book } = input;
  const labels = new Set<string>();
  const base: Omit<ShadowFillRecord, "fills" | "suppressedEntries" | "unfilled" | "unpriced" | "executionShortfall" | "labels"> = {
    recordVersion: SHADOW_FILL_RECORD_VERSION,
    strategyId: record.strategyId,
    strategyVersion: record.strategyVersion,
    charterHash: record.charterHash,
    arm: record.arm,
    decisionAt: record.decisionAt,
    decisionSession: input.decisionSession,
    decisionRecordHash: input.decisionRecordHash,
    computedAt: input.computedAt,
    navAtDecision: book.nav.toFixed(),
    cashAtDecision: book.cash.toFixed(),
  };

  // A non-positive synthetic NAV cannot size a book; record the honest empty outcome rather than throwing a
  // run away (shareTargets throws on nav <= 0 by design - sizing a real book from nothing is an error there).
  if (!book.nav.gt(0)) {
    return { ...base, fills: [], suppressedEntries: [], unfilled: [], unpriced: [], executionShortfall: "0", labels: [SHADOW_BOOK_NON_POSITIVE_NAV] };
  }

  const weights = new Map<string, Dec>();
  for (const w of record.targetWeights) weights.set(w.entityId, new Dec(w.weight));

  const st = shareTargets({ nav: book.nav, weights, prices: input.prices });
  const orders = rebalanceOrders({ nav: book.nav, targets: st.targets, current: book.positions, prices: input.prices, bandPctPoints: input.bandPctPoints });

  // The sealed gate verdict binds the fills: blocked new risk cancels every increase (entries AND adds) and
  // keeps the decreases - HALT_NEW_RISK semantics, not a silent no-op and not a full freeze.
  const suppressedEntries: string[] = [];
  const actionable = orders.filter((o) => {
    if (record.gate.newRiskAllowed || !o.deltaShares.gt(0)) return true;
    suppressedEntries.push(o.entityId);
    return false;
  });

  const fills: ShadowFill[] = [];
  const unfilled: ShadowFillRecord["unfilled"] = [];
  let cash = book.cash;
  const held = new Map(book.positions);
  let shortfall = ZERO;

  for (const order of actionable) {
    const bars = input.bars.get(order.entityId);
    if (!bars || bars.length === 0) {
      unfilled.push({ entityId: order.entityId, side: order.deltaShares.gt(0) ? "BUY" : "SELL", remaining: order.deltaShares.abs().toFixed(), reason: "NO_BARS" });
      continue;
    }
    const side = order.deltaShares.gt(0) ? "BUY" : "SELL";
    const quantity = order.deltaShares.abs();
    const sim = simulateFill({
      intent: { entityId: order.entityId, side, quantity },
      bars,
      // The simulator anchors on the entity's own bar at or before the decision session, as runBacktest does.
      decisionSession: bars.some((b) => b.session === input.decisionSession) ? input.decisionSession : (bars.filter((b) => b.session <= input.decisionSession).at(-1)?.session ?? input.decisionSession),
      delayBars: input.costs.delayBars,
      costs: costModelFor(input.costs, order.entityId),
      maxParticipation: input.costs.maxParticipationOfAdv,
    });
    for (const l of sim.labels) labels.add(l);
    shortfall = shortfall.plus(sim.executionShortfall);
    let applied = ZERO;
    let cashClamped = false;
    for (const f of sim.fills) {
      // Cash-funded, long-only application. One deliberate divergence from runBacktest's in-loop rule: the
      // backtest SKIPS a buy its cash cannot cover whole, which is tolerable there because sized weights carry
      // a cash buffer - but the passive arm targets 100% of NAV, so whole-share flooring at the decision price
      // plus an adverse open makes its full buy unaffordable by a fraction of a share EVERY week, and skipping
      // it would leave B0 permanently uninvested. A buy is instead clamped to the shares the cash covers
      // (fees pro-rated), with the remainder recorded as a CASH remainder. A sell is clamped to shares held.
      if (side === "BUY") {
        let quantityToApply = f.quantity;
        let fees = f.fees;
        let cost = f.notional.plus(f.fees);
        if (cost.gt(cash)) {
          quantityToApply = f.quantity.gt(0) ? cash.div(cost.div(f.quantity)).floor() : ZERO;
          while (quantityToApply.gt(0)) {
            fees = f.fees.times(quantityToApply).div(f.quantity);
            cost = f.price.times(quantityToApply).plus(fees);
            if (!cost.gt(cash)) break;
            quantityToApply = quantityToApply.minus(1);
          }
          cashClamped = true;
          if (!quantityToApply.gt(0)) continue;
        }
        cash = cash.minus(cost);
        held.set(order.entityId, (held.get(order.entityId) ?? ZERO).plus(quantityToApply));
        applied = applied.plus(quantityToApply);
        fills.push({ session: f.session, entityId: order.entityId, side, quantity: quantityToApply.toFixed(), price: f.price.toFixed(), fees: fees.toFixed() });
      } else {
        const have = held.get(order.entityId) ?? ZERO;
        const sell = f.quantity.gt(have) ? have : f.quantity;
        if (!sell.gt(0)) continue;
        cash = cash.plus(f.price.times(sell)).minus(f.fees);
        const left = have.minus(sell);
        if (left.gt(0)) held.set(order.entityId, left);
        else held.delete(order.entityId);
        applied = applied.plus(sell);
        fills.push({ session: f.session, entityId: order.entityId, side, quantity: sell.toFixed(), price: f.price.toFixed(), fees: f.fees.toFixed() });
      }
    }
    const remaining = quantity.minus(applied);
    if (remaining.gt(0)) unfilled.push({ entityId: order.entityId, side, remaining: remaining.toFixed(), reason: cashClamped ? "CASH" : "LIQUIDITY" });
  }

  return {
    ...base,
    fills,
    suppressedEntries: suppressedEntries.sort(),
    unfilled,
    unpriced: [...st.unpriced].sort(),
    executionShortfall: shortfall.toFixed(),
    labels: [...labels].sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// Append-only persistence (mirrors decision-record.ts)
// ---------------------------------------------------------------------------------------------

export class ShadowFillAlreadyRecordedError extends Error {
  constructor(record: ShadowFillRecord) {
    super(`a shadow fill record for ${record.strategyId}@${record.strategyVersion} arm ${record.arm} at ${record.decisionAt} is already recorded`);
    this.name = "ShadowFillAlreadyRecordedError";
  }
}

// Mirrors the decision-record redaction guard: the synthetic book carries no real dollars, but nothing
// FORMATTED as a currency total or shaped like a secret may reach the ledger either way.
const CURRENCY_TOTAL_RE = /\$\s?\d{1,3}(,\d{3})+(\.\d+)?/;
const SECRET_PATTERNS: readonly RegExp[] = [/sk-[a-z0-9]/i, /bearer\s+[a-z0-9._-]+/i, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

export function assertShadowFillRecordSafe(record: ShadowFillRecord): void {
  const everything = canonicalJson(record);
  if (CURRENCY_TOTAL_RE.test(everything)) throw new Error("Shadow fill record rejected: it would serialize with a currency total");
  for (const re of SECRET_PATTERNS) {
    if (re.test(everything)) throw new Error("Shadow fill record rejected: it would serialize with a secret-shaped string");
  }
}

const INSERT = `INSERT INTO shadow_fill_records (
  decision_at, computed_at, strategy_id, strategy_version, charter_hash, arm, decision_record_hash,
  record_json, record_hash
) VALUES (?,?,?,?,?,?,?,?,?)`;

/**
 * Seal and append a shadow fill record. The `(strategy, version, arm, decisionAt)` unique index makes the
 * ledger immutable per decision instant: a second record for the same sealed decision is refused with
 * {@link ShadowFillAlreadyRecordedError} rather than overwriting, so an outcome, once recorded, cannot be
 * recomputed into a different one. Returns the sealed hash.
 */
export function appendShadowFillRecord(db: Db, record: ShadowFillRecord): { hash: string } {
  assertShadowFillRecordSafe(record);
  const json = canonicalJson(record);
  const hash = `sha256:${sha256Hex(json)}`;
  try {
    db.prepare(INSERT).run(record.decisionAt, record.computedAt, record.strategyId, record.strategyVersion, record.charterHash, record.arm, record.decisionRecordHash, json, hash);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test((err as Error).message)) throw new ShadowFillAlreadyRecordedError(record);
    throw err;
  }
  return { hash };
}

/** Every persisted shadow fill record for a strategy version and arm, ascending by decision instant. */
export function shadowFillRecords(db: Db, strategyId: string, strategyVersion: string, arm?: Arm): ShadowFillRecord[] {
  const rows = (
    arm === undefined
      ? db.prepare("SELECT record_json FROM shadow_fill_records WHERE strategy_id = ? AND strategy_version = ? ORDER BY decision_at, arm").all(strategyId, strategyVersion)
      : db.prepare("SELECT record_json FROM shadow_fill_records WHERE strategy_id = ? AND strategy_version = ? AND arm = ? ORDER BY decision_at").all(strategyId, strategyVersion, arm)
  ) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as ShadowFillRecord);
}
