import type { Db, IsoDate, UtcInstant } from "@blackgold/shared";
import type { RiskState } from "../risk/halt.ts";

/**
 * The shadow book's halt inputs, derived from the append-only ledgers (D-54). Pure: every input is passed in.
 *
 * Three rules from docs/AUTOMATION_AND_LIVE_GATES.md, which until now the shadow loop did not honour:
 *
 *  - **Halt states are sticky** (section 7): a move toward a less restrictive state needs an owner action
 *    recorded in the ledger. The state a decision starts from is the one the PREVIOUS sealed decision recorded,
 *    not a fresh NORMAL; the halt machine escalates from there and never relaxes on its own.
 *  - **A reconciliation break unresolved past one session demands HOLD_ONLY** (section 8). The reconciler
 *    re-derives its breaks from the whole append-only ledger every run, so a break never clears by itself: a
 *    missed week stays missed. "Resolved" therefore means the OWNER has examined it and acknowledged it in a
 *    re-arm (section 9.2: "record every discrepancy and its resolution") - or, for a break that genuinely
 *    disappears (a late fill record), that the latest reconcile no longer reports it.
 *  - **Re-arm is staged** (section 9.2): HOLD_ONLY -> HALT_NEW_RISK -> NORMAL, one step per owner action, and
 *    an active fault still binds. `evaluateHaltState` enforces both; this module only collects the re-arms a
 *    decision may consume.
 *
 * An acknowledgement resolves only the OCCURRENCE of a break it was issued during: at or after that occurrence's
 * first report. Break codes name a specific arm and session, so a code written in advance would otherwise
 * silence a future fault before anyone had seen it, and an acknowledgement of an occurrence that cleared would
 * silence its recurrence, which nobody has examined.
 */

/** Where the owner's re-arms land (written by the `shadow rearm` CLI). */
export const SHADOW_HALT_REARM = "shadow.halt_rearm";

export type ShadowFaultState = "NORMAL" | "HALT_NEW_RISK" | "HOLD_ONLY";
export const SHADOW_FAULT_STATES: readonly ShadowFaultState[] = ["NORMAL", "HALT_NEW_RISK", "HOLD_ONLY"];

/** One `shadow.reconciled` ledger event for the charter: the session it reconciled, when, and what it found. */
export type ReconcileObservation = { session: IsoDate; at: UtcInstant; breaks: readonly string[] };

/** One owner re-arm, as the `shadow.halt_rearm` ledger event records it. */
export type ShadowReArm = { to: ShadowFaultState; actor: string; at: UtcInstant; reason: string; acknowledgedBreaks: readonly string[] };

export type ShadowHaltContext = {
  /** The halt state the previous sealed decision recorded (most restrictive across its arms); NORMAL before any. */
  current: ShadowFaultState;
  /** Owner re-arms issued after the previous decision instant and by this one, oldest first. */
  reArms: ShadowReArm[];
  /** Breaks reported for more than one session and not acknowledged: each demands HOLD_ONLY. */
  unresolvedBreaks: string[];
  /** Breaks first reported at the decision session itself: recorded on the event, not yet acted on. */
  freshBreaks: string[];
  /** Currently reported breaks the owner acknowledged during their current occurrence (so they do not hold). */
  acknowledgedBreaks: string[];
};

const RANK: Record<ShadowFaultState, number> = { NORMAL: 0, HALT_NEW_RISK: 1, HOLD_ONLY: 2 };

/** A recorded halt state as a fault state. Anything outside the three (the owner-only flatten state) holds. */
function asFaultState(s: RiskState): ShadowFaultState {
  return s === "NORMAL" || s === "HALT_NEW_RISK" || s === "HOLD_ONLY" ? s : "HOLD_ONLY";
}

const byInstant = <T extends { at: UtcInstant }>(a: T, b: T): number => Date.parse(a.at) - Date.parse(b.at);

export function shadowHaltContext(input: {
  /** The previous sealed decision of this charter: its instant and every arm's recorded halt state. */
  previous: { decisionAt: UtcInstant; haltStates: readonly RiskState[] } | undefined;
  /** Every `shadow.reconciled` observation for the charter, in any order; filtered to the instant here. */
  reconciles: readonly ReconcileObservation[];
  /** Every owner re-arm for the charter, in any order; filtered to the instant here. */
  reArms: readonly ShadowReArm[];
  decisionAt: UtcInstant;
  decisionSession: IsoDate;
}): ShadowHaltContext {
  const atMs = Date.parse(input.decisionAt);
  const known = input.reconciles.filter((r) => Date.parse(r.at) <= atMs).sort(byInstant);
  const knownReArms = input.reArms.filter((r) => Date.parse(r.at) <= atMs).sort(byInstant);

  const unresolvedBreaks: string[] = [];
  const freshBreaks: string[] = [];
  const acknowledged: string[] = [];
  const latest = known.at(-1);
  if (latest !== undefined) {
    for (const code of [...new Set(latest.breaks)].sort()) {
      // The current OCCURRENCE: the unbroken run of reconciles, ending at the latest, that all report this break.
      // A break that cleared and came back is a new occurrence and starts a new run.
      let first = known.length - 1;
      while (first > 0 && (known[first - 1]?.breaks.includes(code) ?? false)) first--;
      const firstReport = known[first] ?? latest;
      // An acknowledgement resolves only the occurrence it was issued during (Codex P2, PR #108): it must come at
      // or after this occurrence's first report. That excludes a code named in advance, and an acknowledgement
      // of an earlier occurrence that cleared - a recurrence has not been examined by anyone.
      const firstReportMs = Date.parse(firstReport.at);
      if (knownReArms.some((r) => r.acknowledgedBreaks.includes(code) && Date.parse(r.at) >= firstReportMs)) {
        acknowledged.push(code);
        continue;
      }
      // "Unresolved past one session": reported on a session before this decision's, and still reported.
      (firstReport.session < input.decisionSession ? unresolvedBreaks : freshBreaks).push(code);
    }
  }

  const current = (input.previous?.haltStates ?? []).map(asFaultState).reduce<ShadowFaultState>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "NORMAL");
  const sinceMs = input.previous === undefined ? Number.NEGATIVE_INFINITY : Date.parse(input.previous.decisionAt);
  const reArms = knownReArms.filter((r) => Date.parse(r.at) > sinceMs);

  return { current, reArms, unresolvedBreaks, freshBreaks, acknowledgedBreaks: acknowledged };
}

// ---------------------------------------------------------------------------------------------
// Ledger readers (mirrors shadow-fills.ts: the pure core above, the store access here)
// ---------------------------------------------------------------------------------------------

/** The kind the fill job writes each reconcile under (shadow-fill-job.ts `SHADOW_RECONCILED`). */
const RECONCILED_KIND = "shadow.reconciled";

/** Everything {@link shadowHaltContext} reads, for one charter, from the decision ledger and the event ledger. */
export function readShadowHaltInputs(
  db: Db,
  charterHash: string,
  decisionAt: UtcInstant,
): { previous: { decisionAt: UtcInstant; haltStates: RiskState[] } | undefined; reconciles: ReconcileObservation[]; reArms: ShadowReArm[] } {
  const last = db.prepare("SELECT MAX(decision_at) AS at FROM decision_records WHERE charter_hash = ? AND decision_at < ?").get(charterHash, decisionAt) as { at: UtcInstant | null };
  const previous =
    last.at === null
      ? undefined
      : {
          decisionAt: last.at,
          haltStates: (db.prepare("SELECT halt_state FROM decision_records WHERE charter_hash = ? AND decision_at = ?").all(charterHash, last.at) as { halt_state: RiskState }[]).map((r) => r.halt_state),
        };
  const eventsOf = (kind: string): { at: UtcInstant; payload: Record<string, unknown> }[] =>
    (db.prepare("SELECT at, payload FROM ledger_events WHERE kind = ? AND json_extract(payload, '$.charterHash') = ? ORDER BY seq").all(kind, charterHash) as { at: UtcInstant; payload: string }[]).map((r) => ({
      at: r.at,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  const reconciles = eventsOf(RECONCILED_KIND).map((e) => ({ session: e.payload["session"] as IsoDate, at: e.at, breaks: (e.payload["breaks"] as string[] | undefined) ?? [] }));
  // A malformed re-arm is no re-arm: relaxing a halt needs a well-formed owner action, so anything else is
  // dropped (the state stays where it was - the fail-closed direction).
  const reArms: ShadowReArm[] = [];
  for (const e of eventsOf(SHADOW_HALT_REARM)) {
    const { to, actor, reason, acknowledgedBreaks } = e.payload;
    if (typeof to !== "string" || !(SHADOW_FAULT_STATES as readonly string[]).includes(to)) continue;
    if (typeof actor !== "string" || actor.trim().length === 0 || typeof reason !== "string" || reason.trim().length === 0) continue;
    const acks = Array.isArray(acknowledgedBreaks) ? acknowledgedBreaks.filter((a): a is string => typeof a === "string") : [];
    reArms.push({ to: to as ShadowFaultState, actor, at: e.at, reason, acknowledgedBreaks: acks });
  }
  return { previous, reconciles, reArms };
}

// ---------------------------------------------------------------------------------------------
// The owner's CLI surface: read the halt picture, record a re-arm
// ---------------------------------------------------------------------------------------------

export class ShadowReArmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShadowReArmError";
  }
}

/** What the next decision would start from, as of `now`: the recorded state, pending re-arms, and every break. */
export function shadowHaltStatus(db: Db, charterHash: string, now: UtcInstant, decisionSession: IsoDate) {
  const inputs = readShadowHaltInputs(db, charterHash, now);
  const ctx = shadowHaltContext({ ...inputs, decisionAt: now, decisionSession });
  const latest = inputs.reconciles.filter((r) => Date.parse(r.at) <= Date.parse(now)).sort(byInstant).at(-1);
  return {
    charterHash,
    recordedState: ctx.current,
    pendingReArms: ctx.reArms.map((r) => ({ to: r.to, actor: r.actor, at: r.at })),
    unresolvedBreaks: ctx.unresolvedBreaks,
    freshBreaks: ctx.freshBreaks,
    acknowledgedBreaks: ctx.acknowledgedBreaks,
    latestReconcile: latest === undefined ? null : { session: latest.session, at: latest.at, breaks: [...latest.breaks] },
  };
}

/**
 * Record an owner re-arm. Refuses anything the decision path would not honour, so the ledger never carries a
 * re-arm that silently does less than the owner believes: an unknown target state, a blank actor or reason, or
 * an acknowledgement of a break the reconciler has not reported (the pure layer ignores those too - this makes
 * the refusal loud instead). Staging and fault clamping still happen at the next decision, in the halt machine.
 */
export function recordShadowReArm(
  db: Db,
  ledger: { append(kind: string, payload: unknown, at: UtcInstant): unknown },
  args: { charterHash: string; to: string; actor: string; reason: string; acknowledge: readonly string[]; now: UtcInstant },
): { charterHash: string; to: ShadowFaultState; actor: string; reason: string; acknowledgedBreaks: string[]; at: UtcInstant } {
  if (!(SHADOW_FAULT_STATES as readonly string[]).includes(args.to)) throw new ShadowReArmError(`--to must be one of ${SHADOW_FAULT_STATES.join(", ")}`);
  const actor = args.actor.trim();
  const reason = args.reason.trim();
  if (actor.length === 0) throw new ShadowReArmError("--actor is required: a re-arm is an owner action recorded with its actor");
  if (reason.length === 0) throw new ShadowReArmError("--reason is required: record the root cause and its resolution");
  // Only a break the LATEST reconcile reports can be acknowledged: an acknowledgement resolves the current
  // occurrence, so one naming a break that has since cleared would resolve nothing (and must not linger).
  const latest = readShadowHaltInputs(db, args.charterHash, args.now).reconciles.filter((r) => Date.parse(r.at) <= Date.parse(args.now)).sort(byInstant).at(-1);
  const reported = new Set(latest?.breaks ?? []);
  const unknown = args.acknowledge.filter((code) => !reported.has(code));
  if (unknown.length > 0) throw new ShadowReArmError(`cannot acknowledge a break the latest reconcile does not report: ${unknown.join(", ")}`);
  const payload = { charterHash: args.charterHash, to: args.to as ShadowFaultState, actor, reason, acknowledgedBreaks: [...new Set(args.acknowledge)].sort() };
  ledger.append(SHADOW_HALT_REARM, payload, args.now);
  return { ...payload, at: args.now };
}
