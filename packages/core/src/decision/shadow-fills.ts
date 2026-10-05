import { Dec, ONE, ZERO, canonicalJson, dec, sha256Hex, type Arm, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { shareTargets, rebalanceOrders } from "../strategy/construct.ts";
import { DEFAULT_MAX_FILL_BARS, simulateFill, type SimBar } from "../research/simulator.ts";
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
 * **Simulate first, then apply in time order** (Codex P1, PR #102 round 2). Every order is simulated with no
 * cash constraint, then ALL simulated fills are applied chronologically - sells before buys within a session,
 * entity id only as the deterministic tiebreak - and only then is the cash constraint enforced. Applying in
 * order-list order instead made a rotation depend on ticker spelling: a buy sorting before the exit that funds
 * it was clamped to a CASH remainder its own same-session sale would have covered.
 *
 * **Orders are worked in decision-session units** (Codex P1, PR #102 round 3). Quantities are sized from the
 * decision close, but the raw bars after a split are in post-split units, so a split between the decision and
 * a delayed fill would mix units (a forward split underfills; a reverse split on an exit sells more than the
 * replayed holding, which then throws in the replay and rolls back every later run). Bars after an intervening
 * split are converted back to decision units for the simulation, each simulated fill is converted forward to
 * the units of the session it executes in, and the held quantities are split-adjusted as the timeline crosses
 * each ex-date - the same split-before-same-day-fill order the replay applies.
 *
 * **Known fidelity divergence from `runBacktest`, recorded here on purpose:** the backtest pre-caps each
 * order at a fraction of trailing ADV before handing it to the simulator. At the synthetic book's level the
 * per-bar participation cap inside `simulateFill` is the binding constraint and the ADV pre-cap can never
 * bind, so it is not duplicated here. If the synthetic level is ever raised to where it could bind, port the
 * pre-cap.
 */

// 2: fills apply in time order with sells first; executionShortfall derives from the fills actually persisted;
//    unfilled `remaining` is in decision-session units; orders crossing a split are worked in decision units.
// 3: `suppressedExits` - a HOLD_ONLY verdict freezes the book, exits included (D-54).
export const SHADOW_FILL_RECORD_VERSION = 3;

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
   * Exits a HOLD_ONLY verdict suppressed: reconciliation uncertainty blocks risk-reducing orders too (D-54).
   * Includes a held line the target removed that had no price at the decision mark.
   */
  suppressedExits: string[];
  /**
   * Orders with quantity left unfilled after the simulator's fill window, with why: `CASH` (the order was fully
   * simulated but the book could not afford all of it - whole-share flooring plus an adverse open, the book's
   * own arithmetic, expected), `LIQUIDITY` (the simulator could not fill it inside its window), or `NO_BARS`
   * (no bar the simulator may use: none at all, or - at zero delay - none on the decision session itself).
   * `remaining` is in decision-session share units (the units the order was sized in).
   */
  unfilled: { entityId: string; side: "BUY" | "SELL"; remaining: string; reason: "CASH" | "LIQUIDITY" | "NO_BARS" }[];
  /** Target entities that could not be priced at the decision mark (no admissible bar). */
  unpriced: string[];
  /**
   * Signed execution shortfall versus the decision close, fees included, in synthetic units - computed from
   * the fills this record persists (clamped quantities, pro-rated fees), never from the simulator's
   * unconstrained quantities.
   */
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
  /** Point-in-time splits for the traded entities; only those AFTER the decision session affect the fills. */
  splits?: readonly ShadowSplit[];
  /** Bars the simulator keeps working a remainder. Defaults to the simulator's own default. */
  maxFillBars?: number;
};

/** A split as the replay applies it: the holding is multiplied by `ratio` at `exDate`, before same-day fills. */
export type ShadowSplit = { entityId: string; ratio: Dec; exDate: IsoDate };

export const SHADOW_BOOK_NON_POSITIVE_NAV = "SHADOW_BOOK_NON_POSITIVE_NAV";
/** An order crossed a split between its decision and a fill; it was worked in decision-session units. */
export const SHADOW_SPLIT_ADJUSTED = "SHADOW_SPLIT_ADJUSTED";

/**
 * The bar the simulator anchors an order on: the entity's own bar on the decision session, or - with a delay -
 * its latest bar before it, as `runBacktest` anchors. At ZERO delay there is no fallback (Codex P2, PR #102
 * round 3): the zero-delay branch fills at the anchor's close, so an older anchor would persist a fill dated
 * before the sealed decision. Undefined means the order cannot be simulated.
 */
export function simulatorAnchorSession(bars: readonly SimBar[] | undefined, decisionSession: IsoDate, delayBars: number): IsoDate | undefined {
  if (bars === undefined || bars.length === 0) return undefined;
  if (bars.some((b) => b.session === decisionSession)) return decisionSession;
  if (delayBars === 0) return undefined;
  return bars.filter((b) => b.session <= decisionSession).at(-1)?.session;
}

/**
 * True when the simulator's whole fill window for an order on this entity has been observed in its OWN bars
 * (Codex P1, PR #102 round 3): `simulateFill` advances over the entity's bar array, not exchange sessions, so a
 * missing session pushes the window's last bar later than any calendar count says. Until then a re-run could
 * fill more of a remainder, and the append-only ledger could never correct a record sealed early.
 */
export function fillWindowObserved(bars: readonly SimBar[] | undefined, decisionSession: IsoDate, delayBars: number, maxFillBars: number = DEFAULT_MAX_FILL_BARS): boolean {
  const anchor = simulatorAnchorSession(bars, decisionSession, delayBars);
  if (bars === undefined || anchor === undefined) return false;
  const anchorIdx = bars.findIndex((b) => b.session === anchor);
  // The simulator's loop starts max(delay, 1) bars after the anchor (the zero-delay decision-bar attempt
  // happens before it) and runs maxFillBars bars.
  const lastIdx = anchorIdx + Math.max(delayBars, 1) + maxFillBars - 1;
  return bars.length > lastIdx;
}

/** The product of the ratios of every split strictly after `after` and at or before `at`, for one entity. */
function splitFactor(splits: readonly ShadowSplit[], after: IsoDate, at: IsoDate): Dec {
  let f = ONE;
  for (const s of splits) if (s.exDate > after && s.exDate <= at) f = f.times(s.ratio);
  return f;
}

/** The entity's bars restated in decision-session units: prices times, volume divided by, the split factor. */
function inDecisionUnits(bars: readonly SimBar[], splits: readonly ShadowSplit[], decisionSession: IsoDate): SimBar[] {
  return bars.map((b) => {
    const f = splitFactor(splits, decisionSession, b.session);
    if (f.eq(ONE)) return b;
    return { ...b, open: b.open.times(f), high: b.high.times(f), low: b.low.times(f), close: b.close.times(f), volume: BigInt(dec(b.volume).div(f).floor().toFixed(0)) };
  });
}

/**
 * Compute the counterfactual fills for one sealed decision record against the shadow book. Pure: every input
 * is passed in; it reads no config, clock, or database, and persists nothing. Deterministic for fixed inputs,
 * so the record is reproducible from the store.
 */
export function counterfactualFills(input: CounterfactualFillInput): ShadowFillRecord {
  const { record, book } = input;
  const labels = new Set<string>();
  const base: Omit<ShadowFillRecord, "fills" | "suppressedEntries" | "suppressedExits" | "unfilled" | "unpriced" | "executionShortfall" | "labels"> = {
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
    return { ...base, fills: [], suppressedEntries: [], suppressedExits: [], unfilled: [], unpriced: [], executionShortfall: "0", labels: [SHADOW_BOOK_NON_POSITIVE_NAV] };
  }

  const weights = new Map<string, Dec>();
  for (const w of record.targetWeights) weights.set(w.entityId, new Dec(w.weight));

  const st = shareTargets({ nav: book.nav, weights, prices: input.prices });
  const orders = rebalanceOrders({ nav: book.nav, targets: st.targets, current: book.positions, prices: input.prices, bandPctPoints: input.bandPctPoints });

  // The sealed gate verdict binds the fills. Blocked new risk cancels every increase (entries AND adds) and
  // keeps the decreases - HALT_NEW_RISK semantics, not a silent no-op. A HOLD_ONLY verdict is a full freeze:
  // reconciliation or order-state uncertainty blocks risk-reducing orders too (AUTOMATION_AND_LIVE_GATES
  // section 7 - "do not touch anything until the picture is reconciled"; the owner-approved close it allows
  // does not exist in shadow).
  const hold = record.gate.haltState === "HOLD_ONLY";
  const suppressedEntries: string[] = [];
  const suppressedExits: string[] = [];
  const actionable = orders.filter((o) => {
    const increase = o.deltaShares.gt(0);
    if (hold) {
      (increase ? suppressedEntries : suppressedExits).push(o.entityId);
      return false;
    }
    if (record.gate.newRiskAllowed || !increase) return true;
    suppressedEntries.push(o.entityId);
    return false;
  });
  // rebalanceOrders drops an exit it cannot price (a suspended or delisted holding), so the order list alone
  // under-reports the freeze. A held line the target removes is an exit whatever its price: record it from the
  // book (Codex P2, PR #108 round 5). A held line still targeted but unpriced has no known direction; it stays
  // on `unpriced`.
  if (hold) {
    for (const [entityId, q] of book.positions) {
      if (q.gt(0) && weights.get(entityId)?.gt(0) !== true && input.prices.get(entityId) === undefined) suppressedExits.push(entityId);
    }
  }

  // Phase 1: simulate every actionable order with no cash constraint, in decision-session units.
  type Worked = { entityId: string; side: "BUY" | "SELL"; quantity: Dec; decisionClose: Dec; splits: ShadowSplit[]; simUnfilled: Dec; applied: Dec; cashShort: boolean };
  type Slot = { kind: "NO_BARS"; entityId: string; side: "BUY" | "SELL"; quantity: Dec } | { kind: "WORKED"; work: Worked };
  type Step =
    | { kind: "SPLIT"; date: IsoDate; entityId: string; ratio: Dec }
    | { kind: "FILL"; date: IsoDate; side: "BUY" | "SELL"; entityId: string; quantity: Dec; decisionUnits: Dec; price: Dec; fees: Dec; factor: Dec; work: Worked };
  const slots: Slot[] = [];
  const steps: Step[] = [];
  const laterSplits = (input.splits ?? []).filter((s) => s.exDate > input.decisionSession);

  for (const order of actionable) {
    const side = order.deltaShares.gt(0) ? "BUY" : "SELL";
    const quantity = order.deltaShares.abs();
    const bars = input.bars.get(order.entityId);
    const anchor = simulatorAnchorSession(bars, input.decisionSession, input.costs.delayBars);
    if (bars === undefined || anchor === undefined) {
      slots.push({ kind: "NO_BARS", entityId: order.entityId, side, quantity });
      continue;
    }
    const splits = laterSplits.filter((s) => s.entityId === order.entityId);
    const sim = simulateFill({
      intent: { entityId: order.entityId, side, quantity },
      bars: splits.length === 0 ? bars : inDecisionUnits(bars, splits, input.decisionSession),
      decisionSession: anchor,
      delayBars: input.costs.delayBars,
      costs: costModelFor(input.costs, order.entityId),
      maxParticipation: input.costs.maxParticipationOfAdv,
      ...(input.maxFillBars === undefined ? {} : { maxFillBars: input.maxFillBars }),
    });
    for (const l of sim.labels) labels.add(l);
    const work: Worked = { entityId: order.entityId, side, quantity, decisionClose: sim.decisionClose, splits, simUnfilled: sim.unfilledQuantity, applied: ZERO, cashShort: false };
    slots.push({ kind: "WORKED", work });
    for (const f of sim.fills) {
      // Forward to the units of the session the fill executes in; notional and fees are unit-invariant.
      const factor = splitFactor(splits, input.decisionSession, f.session);
      if (!factor.eq(ONE)) labels.add(SHADOW_SPLIT_ADJUSTED);
      steps.push({ kind: "FILL", date: f.session, side, entityId: order.entityId, quantity: f.quantity.times(factor), decisionUnits: f.quantity, price: f.price.div(factor), fees: f.fees, factor, work });
    }
  }
  for (const s of laterSplits) steps.push({ kind: "SPLIT", date: s.exDate, entityId: s.entityId, ratio: s.ratio });

  // Phase 2: apply in time order - a split before any same-day fill (the replay's order), sells before buys
  // within a session so a rotation funds its buys from its own sales, entity id as the deterministic tiebreak.
  const rank = (s: Step): number => (s.kind === "SPLIT" ? 0 : s.side === "SELL" ? 1 : 2);
  steps.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : rank(a) !== rank(b) ? rank(a) - rank(b) : a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));

  const fills: ShadowFill[] = [];
  let cash = book.cash;
  const held = new Map(book.positions);
  let shortfall = ZERO;
  for (const step of steps) {
    if (step.kind === "SPLIT") {
      const q = held.get(step.entityId);
      if (q !== undefined) held.set(step.entityId, q.times(step.ratio));
      continue;
    }
    // Cash-funded, long-only application. One deliberate divergence from runBacktest's in-loop rule: the
    // backtest SKIPS a buy its cash cannot cover whole, which is tolerable there because sized weights carry a
    // cash buffer - but the passive arm targets 100% of NAV, so whole-share flooring at the decision price plus
    // an adverse open makes its full buy unaffordable by a fraction of a share EVERY week, and skipping it would
    // leave B0 permanently uninvested. A buy is instead clamped to the shares the cash covers (fees pro-rated),
    // with the remainder recorded as a CASH remainder. A sell is clamped to shares held (fees pro-rated).
    let quantity = step.quantity;
    let fees = step.fees;
    if (step.side === "BUY") {
      let cost = step.price.times(quantity).plus(fees);
      if (cost.gt(cash)) {
        step.work.cashShort = true;
        quantity = cash.div(cost.div(step.quantity)).floor();
        while (quantity.gt(0)) {
          fees = step.fees.times(quantity).div(step.quantity);
          cost = step.price.times(quantity).plus(fees);
          if (!cost.gt(cash)) break;
          quantity = quantity.minus(1);
        }
        if (!quantity.gt(0)) continue;
      }
      cash = cash.minus(cost);
      held.set(step.entityId, (held.get(step.entityId) ?? ZERO).plus(quantity));
    } else {
      const have = held.get(step.entityId) ?? ZERO;
      if (step.quantity.gt(have)) {
        quantity = have;
        fees = step.fees.times(quantity).div(step.quantity);
      }
      if (!quantity.gt(0)) continue;
      cash = cash.plus(step.price.times(quantity)).minus(fees);
      const left = have.minus(quantity);
      if (left.gt(0)) held.set(step.entityId, left);
      else held.delete(step.entityId);
    }
    // Shortfall from what is actually persisted (Codex P2, PR #102 round 2): side-signed against the decision
    // close restated in this session's units, with the applied fees.
    const sign = step.side === "BUY" ? ONE : ONE.negated();
    shortfall = shortfall.plus(sign.times(step.price.minus(step.work.decisionClose.div(step.factor))).times(quantity)).plus(fees);
    step.work.applied = step.work.applied.plus(quantity.eq(step.quantity) ? step.decisionUnits : quantity.div(step.factor));
    fills.push({ session: step.date, entityId: step.entityId, side: step.side, quantity: quantity.toFixed(), price: step.price.toFixed(), fees: fees.toFixed() });
  }

  // A simulator remainder is LIQUIDITY (bars could still fill it); an order the simulator filled whole but the
  // book could not afford is CASH. Listed in order-list order, like the orders themselves.
  const unfilled: ShadowFillRecord["unfilled"] = [];
  for (const slot of slots) {
    if (slot.kind === "NO_BARS") {
      unfilled.push({ entityId: slot.entityId, side: slot.side, remaining: slot.quantity.toFixed(), reason: "NO_BARS" });
      continue;
    }
    const w = slot.work;
    const remaining = w.quantity.minus(w.applied);
    if (remaining.gt(0)) unfilled.push({ entityId: w.entityId, side: w.side, remaining: remaining.toFixed(), reason: w.simUnfilled.gt(0) || !w.cashShort ? "LIQUIDITY" : "CASH" });
  }

  return {
    ...base,
    fills,
    suppressedEntries: suppressedEntries.sort(),
    suppressedExits: suppressedExits.sort(),
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
