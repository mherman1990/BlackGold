import { Dec, ONE, ZERO, type Mode, type UtcInstant } from "@blackgold/shared";
import type { RiskConfig, RestrictedListConfig } from "../config/schema.ts";
import type { Charter } from "../strategy/charter.ts";
import { evaluateHaltState, type HaltInput, type PortfolioSnapshot } from "../risk/halt.ts";
import { evaluateDecisionGate } from "./gate.ts";
import type { ComplianceInput } from "../compliance/engine.ts";
import {
  assertSealsProspectiveDecisions,
  type DecisionGateOutcome,
  type ProspectiveDecisionRecord,
  DECISION_RECORD_VERSION,
} from "./decision-record.ts";
import { prospectiveTargetBooks, type ArmTargetBook, type DecisionEngineDeps } from "./prospective.ts";

/**
 * The prospective SHADOW/PAPER decision, composed and sealed (D-53 slice 2b).
 *
 * This is the seam that turns each arm's deterministically-constructed target book (slice 2a) into the sealed,
 * timestamp-locked {@link ProspectiveDecisionRecord} the rung-2 ladder requires - the target book PLUS the
 * deterministic decision-gate verdict, and nothing else. It composes only the existing deterministic engines
 * ({@link prospectiveTargetBooks}, {@link evaluateHaltState}, {@link evaluateDecisionGate}); it constructs no
 * order, chooses no account, and reaches no broker. No model output is anywhere near it (threat model T-05).
 *
 * It is pure: every input - the charter, the read surface, the policy, the shadow book state, and the decision
 * and seal instants - is passed in. It reads no config, env, clock, or database. The caller (the serve
 * scheduler, slice 2c) resolves those and persists each returned record with `appendDecisionRecord`.
 *
 * Two deliberate asymmetries between the arms, both matching the charter's own design:
 *
 *  - **B0 is the passive comparator.** It buys the primary benchmark once and holds (`runBacktest`'s B0,
 *    ALPHA_CHARTER.md). It is a reference series, not a sleeve book, so the sleeve's diversification and
 *    look-through limits do not apply to a 100%-benchmark hold. Its gate respects only the halt state: a halted
 *    system takes no new risk in any arm, but a NORMAL one lets the passive hold stand.
 *  - **B1 (and any deterministic arm) is the real book.** It runs the full decision gate - halt, every risk
 *    limit, and new-risk compliance with enforced coverage - exactly as the broker gateway will.
 *
 * Fail-closed compliance is honest here, not bypassed: a candidate whose `lookThrough` resolver is absent (or
 * returns `undefined` for it) carries `themeExposures: undefined`, which the compliance engine treats as an
 * unknown state that blocks NEW risk (`UNKNOWN_LOOK_THROUGH`). A shadow B1 record then seals
 * `newRiskAllowed: false` with that reason. That is the correct record to seal: the sealed target weights
 * (byte-for-byte the backtested ones, per the slice-2a anti-drift test) are the rung-2 evidence, and the gate
 * verdict truthfully reports that no new exposure cleared. The store-backed resolver is slice 3a-3's
 * `storedLookThroughResolver` (`compliance/theme-membership.ts`): published PIT holdings + the owner's
 * theme-membership config + the restricted list. It clears B1 only where the owner's real config says so;
 * the tracked example config is fake, so a deployment on examples still fails closed.
 */

/** The shadow book carried into a decision: current weights (for new-risk deltas) and the halt portfolio snapshot. */
export type ShadowBookState = {
  /**
   * The shadow book in force before this decision, as fractions of NAV keyed by entity id. Empty means
   * decide-from-empty: every target holding then counts as new risk, the fail-closed default. Slice 2b carries
   * no state across sessions (each decision is from empty); full shadow-portfolio carry is slice 3.
   */
  currentWeights: ReadonlyMap<string, Dec>;
  /**
   * The synthetic shadow portfolio the halt machine reads: NAV, high-water mark, and session-start NAV. It is a
   * unit synthetic book (no real dollars, so nothing to leak), and with no carried counterfactual P&L it has no
   * drawdown - halt is NORMAL unless a stale/incident signal is supplied. Never a household total.
   */
  portfolio: PortfolioSnapshot;
};

/** A unit synthetic shadow portfolio: no positions, no drawdown, no real dollars. The slice-2b default state. */
export const EMPTY_SHADOW_BOOK: ShadowBookState = {
  currentWeights: new Map(),
  portfolio: { nav: ONE, highWaterMark: ONE, sessionStartNav: ONE },
};

/** Resolved compliance identity for one symbol (its ticker history and stable entity id), from the entity map. */
export type SymbolIdentity = { identifiers: readonly string[]; entityId: string | undefined };

export type ShadowDecisionContext = {
  /** Must satisfy {@link sealsProspectiveDecisions}; the sealer refuses RESEARCH/BACKTEST. */
  mode: Mode;
  /** `sha256:<hex>` of the charter, from the loaded charter artifact (never recomputed here). */
  charterHash: string;
  /**
   * `sha256:<hex>` of each operative policy file, keyed by file (e.g. `risk_yaml`), sealed into every record
   * (Codex P2, round 9): the record must be attributable to its exact policy byte-state on its own, even for
   * the halt-only passive arm whose gate reads no policy content.
   */
  policyHashes: Record<string, string>;
  risk: RiskConfig;
  restrictedList: RestrictedListConfig;
  /** The narrowed point-in-time read surface plus calendar; `asOf` enforces the availability filter. */
  deps: DecisionEngineDeps;
  /** The timestamp-locked decision instant. Every read that formed the books was `asOf` this instant. */
  decisionAt: UtcInstant;
  /** When the records are sealed (>= decisionAt). */
  sealedAt: UtcInstant;
  /** The shadow book carried into this decision. Defaults to {@link EMPTY_SHADOW_BOOK} when omitted. */
  state?: ShadowBookState;
  /** Frozen snapshot ids the books were built from. Usually empty for a live incremental read. */
  snapshotIds?: readonly string[];
  /** Critical inputs known stale or missing at decision time (e.g. `market_data`); each fails closed for new risk. */
  staleInputs?: readonly string[];
  /**
   * Resolved compliance identity per symbol (ticker history + stable entity id). Absent, a symbol is checked
   * under its own ticker alone with no resolved entity - the documented "no ticker history" path.
   */
  identity?: (symbol: string) => SymbolIdentity;
  /**
   * ETF theme look-through per symbol. Absent (or returning `undefined`), look-through has NOT run, which the
   * compliance engine treats as an unknown state that blocks new risk. `[]` asserts a run that found nothing.
   */
  lookThrough?: (symbol: string) => readonly string[] | undefined;
};

/** Project the sealed gate outcome from a full verdict (the redacted subset the record carries). */
function outcome(v: { newRiskAllowed: boolean; haltState: DecisionGateOutcome["haltState"]; increasedRisk: string[]; blockedBy: string[] }): DecisionGateOutcome {
  return { newRiskAllowed: v.newRiskAllowed, haltState: v.haltState, increasedRisk: [...v.increasedRisk], blockedBy: [...v.blockedBy] };
}

/** Build the halt input shared by every arm this decision (same portfolio and signals). */
function haltInputOf(ctx: ShadowDecisionContext, state: ShadowBookState): HaltInput {
  return {
    policy: ctx.risk,
    current: "NORMAL",
    portfolio: state.portfolio,
    ...(ctx.staleInputs === undefined ? {} : { staleInputs: ctx.staleInputs }),
  };
}

/** A new-risk compliance candidate for one target line, resolving identity and look-through through the context. */
function candidateFor(ctx: ShadowDecisionContext, symbol: string): Omit<ComplianceInput, "isNewRisk"> {
  const id = ctx.identity?.(symbol) ?? { identifiers: [symbol], entityId: undefined };
  const themeExposures = ctx.lookThrough === undefined ? undefined : ctx.lookThrough(symbol);
  return {
    symbol,
    identifiers: id.identifiers,
    entityId: id.entityId,
    themeExposures,
    restrictedList: ctx.restrictedList,
    now: ctx.decisionAt,
    maxListAgeDays: ctx.risk.staleness.restrictedListMaxAgeDays,
  };
}

/** The gate outcome for one arm's target book: the full decision gate for the real book, halt-only for the passive comparator. */
function gateForArm(charter: Charter, ctx: ShadowDecisionContext, state: ShadowBookState, book: ArmTargetBook): DecisionGateOutcome {
  const halt = haltInputOf(ctx, state);

  if (book.arm === "B0_PASSIVE") {
    // The passive comparator is not a sleeve book: the sleeve's diversification and compliance limits do not
    // apply to a buy-and-hold of the benchmark. Only the halt state binds - a halted system adds no new risk
    // anywhere, a NORMAL one lets the passive hold stand.
    const decision = evaluateHaltState(halt);
    const normal = decision.state === "NORMAL";
    const blockedBy = normal ? [] : decision.faults.length === 0 ? [`halt state ${decision.state} does not permit new risk`] : decision.faults.map((f) => `halt ${f.code}: ${f.detail}`);
    return outcome({ newRiskAllowed: normal, haltState: decision.state, increasedRisk: [], blockedBy });
  }

  // The real deterministic book runs the full gate: halt, every risk limit, and new-risk compliance with
  // enforced coverage - exactly as the broker gateway re-checks it. A candidate is supplied for every target
  // line, so every increasing holding is covered; held-flat lines carry a harmless extra candidate.
  const weights = new Map(book.targetWeights.map((w) => [w.entityId, w.weight]));
  const newRiskCandidates: Omit<ComplianceInput, "isNewRisk">[] = book.targetWeights.filter((w) => w.weight.gt(ZERO)).map((w) => candidateFor(ctx, w.entityId));
  const verdict = evaluateDecisionGate({
    halt,
    limits: { policy: ctx.risk, charter, weights, cashWeight: book.cashWeight },
    currentWeights: state.currentWeights,
    newRiskCandidates,
  });
  return outcome(verdict);
}

/** Seal one arm's target book and gate verdict into a prospective decision record (unsealed; the caller appends it). */
function recordFor(charter: Charter, ctx: ShadowDecisionContext, book: ArmTargetBook, gate: DecisionGateOutcome): ProspectiveDecisionRecord {
  return {
    recordVersion: DECISION_RECORD_VERSION,
    strategyId: charter.strategy_id,
    strategyVersion: charter.charter_version,
    charterHash: ctx.charterHash,
    arm: book.arm,
    mode: ctx.mode,
    policyHashes: { ...ctx.policyHashes },
    decisionAt: ctx.decisionAt,
    sealedAt: ctx.sealedAt,
    snapshotIds: [...(ctx.snapshotIds ?? [])].sort(),
    targetWeights: book.targetWeights.map((w) => ({ entityId: w.entityId, weight: w.weight.toFixed() })),
    cashWeight: book.cashWeight.toFixed(),
    gate,
    constructionVersion: charter.component_versions.portfolio_construction,
    notes: [],
  };
}

/**
 * Compute the sealed prospective decision records for every arm at one decision instant. Refuses a non-sealing
 * mode up front (RESEARCH/BACKTEST may not seal decisions). Returns the records in arm order [B0, B1]; the
 * caller persists each with `appendDecisionRecord`, which is idempotent per (strategy version, arm, instant).
 */
export function shadowDecisionRecords(charter: Charter, ctx: ShadowDecisionContext): ProspectiveDecisionRecord[] {
  assertSealsProspectiveDecisions(ctx.mode);
  const state = ctx.state ?? EMPTY_SHADOW_BOOK;
  const held = new Set(state.currentWeights.keys());
  const books = prospectiveTargetBooks(charter, ctx.deps, ctx.decisionAt, held);

  // Uniformly stale market data fails closed (Codex P1, round 9): when EVERY universe member lacks the newest
  // admissible bar (a failed or incomplete ingest), `computeFeatures` moves its shared anchor back to the
  // newest older session - honest for cross-sectional ranking, but no per-symbol STALE_ANCHOR fires, so a
  // plausible book would otherwise clear the gate on uniformly stale prices. A deterministic book anchored
  // before the decision session therefore enters the halt machine as a stale input: every arm still seals,
  // with new risk blocked and the anchor gap on the record. (A single broken feed keeps the anchor current
  // and marks only that member STALE_ANCHOR; this fault is the all-feeds-behind case.)
  const decisionSession = ctx.deps.calendar.previousSession(ctx.decisionAt);
  // `anchorFromData === false` is the zero-observation case (Codex P1, round 10): with NO admissible bar
  // anywhere, computeFeatures substitutes the decision session as a calendar fallback, so the date comparison
  // alone would read an empty database as fresh.
  const staleMarket = books.flatMap((b) => {
    if (b.arm === "B0_PASSIVE") return [];
    if (!b.anchorFromData) return [`market_data_stale:${b.arm} has no admissible market observations at ${decisionSession}`];
    const faults: string[] = [];
    if (b.anchorSession < decisionSession) faults.push(`market_data_stale:${b.arm} anchored at ${b.anchorSession}, decision session ${decisionSession}`);
    // A lagging CASH feed leaves the shared anchor current (Codex P1, round 11): the hurdle is withheld by
    // computeFeatures, but withholding alone would seal a clean all-cash book - the stale leg must block.
    if (!b.cashAtAnchor) faults.push(`market_data_stale:${b.arm} cash leg has no bar at anchor ${b.anchorSession}`);
    return faults;
  });
  const effCtx = staleMarket.length === 0 ? ctx : { ...ctx, staleInputs: [...(ctx.staleInputs ?? []), ...staleMarket] };
  return books.map((book) => recordFor(charter, effCtx, book, gateForArm(charter, effCtx, state, book)));
}
