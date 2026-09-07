import { integrityCheck, type Db, type UtcInstant } from "@blackgold/shared";
import { Ledger } from "../ledger/ledger.ts";

/**
 * The full ledger/database integrity verification, moved off the health probe's hot path.
 *
 * `runHealth` runs on every request and the container healthcheck hits it every 60 s. Rehashing the whole
 * ledger (`verifyChain`), recomputing every sealed day's root (`verifySeals`), and running
 * `PRAGMA integrity_check` over the whole database on each of those calls is O(store size) and becomes a
 * restart-loop-class cost once the ledger carries real volume (`HANDOFF.md` §7). This module runs that full
 * suite on a schedule instead and records the outcome; the hot path verifies only the unsealed tail
 * (`Ledger.verifyChainSinceLastSeal`) and reports the last full result from here. No detection guarantee is
 * lost - a tamper in a sealed day is still caught by the scheduled full check - only the latency to catch one
 * in the frozen prefix grows from one probe to one schedule.
 */
export type FullVerification = {
  at: UtcInstant;
  /** `integrityOk && chainOk && sealsOk`. */
  ok: boolean;
  integrityOk: boolean;
  chainOk: boolean;
  sealsOk: boolean;
  events: number;
  /** Compact human summary; the specific break/mismatch when not ok. */
  detail: string;
};

const KV_KEY = "last_full_verification";

/**
 * How stale the last full verification may be before the hot path flags it. Two days: the job runs daily, so
 * one full grace day means a single missed run does not raise a false alarm. Reported, never fatal - see
 * `runHealth`.
 */
export const FULL_VERIFICATION_STALE_MS = 2 * 24 * 3_600_000;

/** Run the full integrity suite, persist the outcome (kv + health_checks history), and return it. */
export function runFullVerification(db: Db, ledger: Ledger, now: UtcInstant): FullVerification {
  const integrity = integrityCheck(db);
  const chain = ledger.verifyChain();
  const seals = ledger.verifySeals();
  const events = ledger.count();
  const parts: string[] = [];
  if (!integrity.ok) parts.push(`db integrity: ${integrity.messages.join("; ")}`);
  if (!chain.ok) parts.push(`chain broken at seq ${chain.brokenAt}: ${chain.reason}`);
  if (!seals.ok) parts.push(`seal mismatch: ${seals.mismatches.join(",")}`);
  const result: FullVerification = {
    at: now,
    ok: integrity.ok && chain.ok && seals.ok,
    integrityOk: integrity.ok,
    chainOk: chain.ok,
    sealsOk: seals.ok,
    events,
    detail: parts.length === 0 ? `all clear over ${events} events` : parts.join("; "),
  };
  db.transaction(() => {
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KV_KEY, JSON.stringify(result));
    db.prepare("INSERT INTO health_checks (at, component, ok, detail) VALUES (?, ?, ?, ?)").run(now, "full_verification", result.ok ? 1 : 0, result.detail);
  });
  return result;
}

/** The last recorded full verification, or null when none has run yet (a fresh install, or before the first daily job). */
export function readLastFullVerification(db: Db): FullVerification | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(KV_KEY) as { value: string } | undefined;
  if (!row) return null;
  const raw: unknown = JSON.parse(row.value);
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // Defensive coercion: this is our own write, but a malformed row must not crash the probe.
  return {
    at: String(r["at"]) as UtcInstant,
    ok: r["ok"] === true,
    integrityOk: r["integrityOk"] === true,
    chainOk: r["chainOk"] === true,
    sealsOk: r["sealsOk"] === true,
    events: typeof r["events"] === "number" ? r["events"] : 0,
    detail: typeof r["detail"] === "string" ? r["detail"] : "",
  };
}
