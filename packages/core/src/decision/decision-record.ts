import { canonicalJson, isLiveMode, sha256Hex, type Arm, type Db, type Mode, type UtcInstant } from "@blackgold/shared";
import type { RiskState } from "../risk/halt.ts";

/**
 * The sealed, timestamp-locked prospective decision record (docs/AUTOMATION_AND_LIVE_GATES.md rung 2, SHADOW:
 * "seal timestamp-locked decision records for all four arms before outcomes are knowable").
 *
 * It is the append-only artifact of the prospective decision loop: at one decision instant, for one arm, it
 * carries the deterministically-constructed target book and the deterministic decision-gate verdict, and
 * NOTHING else. Two guarantees, both structural and both checked:
 *
 *  - **No execution surface.** The type has no field for an order, a client-order id, a broker, an account, or
 *    a fill. A SHADOW record decides; it never executes. The order lifecycle is a later, mode-gated layer
 *    (PAPER and above) that reads these records; sealing one can reach no broker.
 *  - **No leaked value.** Weights are fractions of NAV, never dollars, and {@link assertDecisionRecordSafe}
 *    rejects a household/sleeve currency total or a secret pattern that a free-text note could smuggle in -
 *    the same redaction siblings as the evidence packet and the notification guard.
 *
 * Sealing is deterministic: canonical JSON, then `sha256:<hex>`. The record's arrays must already be in
 * canonical order when sealed (the producer sorts them), because the hash is taken over the bytes as given.
 */

export const DECISION_RECORD_VERSION = 2;

/**
 * The modes that may seal a prospective decision record: SHADOW and PAPER (and the two live modes, which are
 * absent by construction in this build). RESEARCH and BACKTEST may not - the ladder forbids BACKTEST from
 * writing the prospective decision ledger, and RESEARCH produces no decision record with an executable
 * timestamp at all.
 */
export function sealsProspectiveDecisions(mode: Mode): boolean {
  return mode === "SHADOW" || mode === "PAPER" || isLiveMode(mode);
}

export class DecisionModeError extends Error {
  constructor(mode: Mode) {
    super(`mode ${mode} may not seal a prospective decision record (only SHADOW and PAPER do)`);
    this.name = "DecisionModeError";
  }
}

export function assertSealsProspectiveDecisions(mode: Mode): void {
  if (!sealsProspectiveDecisions(mode)) throw new DecisionModeError(mode);
}

/** One target book line: an entity's target weight as a fraction of NAV, as a decimal string. Never a dollar. */
export type DecisionTargetWeight = { entityId: string; weight: string };

/** The deterministic decision-gate verdict as sealed into the record (a redacted projection of the gate). */
export type DecisionGateOutcome = {
  newRiskAllowed: boolean;
  haltState: RiskState;
  /** Holdings taking new or increased risk this decision. */
  increasedRisk: string[];
  /** Every blocking reason across halt, limits, and compliance, flattened. Empty when allowed. */
  blockedBy: string[];
};

export type ProspectiveDecisionRecord = {
  recordVersion: number;
  strategyId: string;
  strategyVersion: string;
  /** `sha256:<hex>` of the charter the decision was made under. */
  charterHash: string;
  arm: Arm;
  /** The mode the record was sealed in. Must satisfy {@link sealsProspectiveDecisions}. */
  mode: Mode;
  /**
   * `sha256:<hex>` of each operative policy file the decision was made under, keyed by file (e.g. `risk_yaml`).
   * Sealed INTO the record (recordVersion 2, Codex P2 round 9) so an arm is attributable to its exact policy
   * byte-state on its own: a pre-sealed arm whose gate happens not to read a policy (the halt-only passive
   * comparator) still differs from a re-derivation under replaced policy files, and a run completing a pair
   * can prove both arms saw the same policies. Empty only where no policy file was read (e.g. direct research
   * seals); the shadow job always supplies all three.
   */
  policyHashes: Record<string, string>;
  /** The timestamp-locked decision instant. Reads that formed the book were `asOf` this instant. */
  decisionAt: UtcInstant;
  /** When the record was sealed (>= decisionAt). */
  sealedAt: UtcInstant;
  /** The frozen snapshot ids the target book was constructed from. Sorted. */
  snapshotIds: string[];
  /** Target risk-ETF weights, fractions of NAV, sorted by entityId. The cash leg is `cashWeight`. */
  targetWeights: DecisionTargetWeight[];
  /** `1 - sum(targetWeights)` held in cash, as a decimal string. */
  cashWeight: string;
  gate: DecisionGateOutcome;
  /** The portfolio-construction rule version the book was built with. */
  constructionVersion: number;
  notes: string[];
};

export class DecisionRecordRedactionError extends Error {
  constructor(reason: string) {
    super(`Decision record rejected: it would serialize with ${reason}`);
    this.name = "DecisionRecordRedactionError";
  }
}

// A formatted currency total such as "$12,345" or "$1,234,567.89". Mirrors the evidence-packet guard
// (research/packet.ts) and the notification guard (notify/redact.ts) deliberately: weights are fractions, so a
// dollar total in this record could only arrive through a stray free-text note, and it must never leave the host.
const CURRENCY_TOTAL_RE = /\$\s?\d{1,3}(,\d{3})+(\.\d+)?/;

const SECRET_PATTERNS: readonly { re: RegExp; reason: string }[] = [
  { re: /sk-[a-z0-9]/i, reason: 'an API key ("sk-...")' },
  { re: /bearer\s+[a-z0-9._-]+/i, reason: "a bearer credential" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, reason: "an AWS access key id" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "a private key block" },
];

/** Throw if the record would carry a household/sleeve currency total or a secret anywhere in its serialized form. */
export function assertDecisionRecordSafe(record: ProspectiveDecisionRecord): void {
  const everything = canonicalJson(record);
  if (CURRENCY_TOTAL_RE.test(everything)) throw new DecisionRecordRedactionError("a currency total");
  for (const { re, reason } of SECRET_PATTERNS) {
    if (re.test(everything)) throw new DecisionRecordRedactionError(reason);
  }
}

/**
 * Seal a prospective decision record to its canonical wire form and hash. Refuses a non-sealing mode and
 * re-runs the redaction guard first, so a caller cannot receive a sealed record from RESEARCH/BACKTEST or one
 * that would leak a dollar total or a secret.
 */
export function sealDecision(record: ProspectiveDecisionRecord): { json: string; hash: string } {
  assertSealsProspectiveDecisions(record.mode);
  assertDecisionRecordSafe(record);
  const json = canonicalJson(record);
  return { json, hash: `sha256:${sha256Hex(json)}` };
}

// ---------------------------------------------------------------------------------------------
// Append-only persistence
// ---------------------------------------------------------------------------------------------

export class DecisionAlreadySealedError extends Error {
  constructor(record: ProspectiveDecisionRecord) {
    super(`a decision record for ${record.strategyId}@${record.strategyVersion} arm ${record.arm} at ${record.decisionAt} is already sealed`);
    this.name = "DecisionAlreadySealedError";
  }
}

const INSERT = `INSERT INTO decision_records (
  decision_at, sealed_at, strategy_id, strategy_version, charter_hash, arm, mode, new_risk_allowed, halt_state,
  record_json, record_hash
) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * Seal and append a prospective decision record. The `(strategy, version, arm, decisionAt)` unique index makes
 * the ledger immutable per instant: a second seal for the same instant - identical or not - is refused with
 * {@link DecisionAlreadySealedError} rather than overwriting, so "zero missing decision records" stays a
 * checkable property and a re-run cannot silently rewrite history. Returns the sealed hash.
 */
export function appendDecisionRecord(db: Db, record: ProspectiveDecisionRecord): { hash: string } {
  const { json, hash } = sealDecision(record);
  try {
    db.prepare(INSERT).run(
      record.decisionAt,
      record.sealedAt,
      record.strategyId,
      record.strategyVersion,
      record.charterHash,
      record.arm,
      record.mode,
      record.gate.newRiskAllowed ? 1 : 0,
      record.gate.haltState,
      json,
      hash,
    );
  } catch (err) {
    if (/UNIQUE constraint failed/i.test((err as Error).message)) throw new DecisionAlreadySealedError(record);
    throw err;
  }
  return { hash };
}

/** Total number of sealed decision records, for the status surface and tests. */
export function decisionRecordCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM decision_records").get() as { n: number }).n;
}

/** The latest sealed decision instant for a strategy version, or undefined when none is sealed yet. */
export function latestDecisionAt(db: Db, strategyId: string, strategyVersion: string): UtcInstant | undefined {
  const row = db
    .prepare("SELECT max(decision_at) AS m FROM decision_records WHERE strategy_id = ? AND strategy_version = ?")
    .get(strategyId, strategyVersion) as { m: string | null };
  return row.m === null ? undefined : (row.m as UtcInstant);
}
