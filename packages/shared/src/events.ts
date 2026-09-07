import { hashJson, type Sha256Hex } from "./hash.ts";
import type { UtcInstant } from "./time.ts";

/** One record in the append-only, hash-chained ledger. Tamper-evident, not immutable. */
export type LedgerEvent = {
  seq: number;
  at: UtcInstant;
  kind: string;
  payload: unknown;
  prevHash: Sha256Hex;
  hash: Sha256Hex;
};

export const GENESIS_HASH = "0".repeat(64) as Sha256Hex;

export function computeEventHash(e: Omit<LedgerEvent, "hash">): Sha256Hex {
  return hashJson({ seq: e.seq, at: e.at, kind: e.kind, payload: e.payload, prevHash: e.prevHash });
}

export type ChainVerdict = { ok: true } | { ok: false; brokenAt: number; reason: string };

export function verifyEventChain(
  events: readonly LedgerEvent[],
  expectedFirstPrev: Sha256Hex = GENESIS_HASH,
): ChainVerdict {
  let prev = expectedFirstPrev;
  let expectedSeq = events[0]?.seq ?? 1;
  for (const e of events) {
    if (e.seq !== expectedSeq) return { ok: false, brokenAt: e.seq, reason: `sequence gap: expected ${expectedSeq}` };
    if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, reason: "prevHash mismatch" };
    if (computeEventHash(e) !== e.hash) return { ok: false, brokenAt: e.seq, reason: "hash mismatch" };
    prev = e.hash;
    expectedSeq++;
  }
  return { ok: true };
}
