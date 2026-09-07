import { nowUtc, type UtcInstant } from "@blackgold/shared";
import type { Ledger } from "../../ledger/ledger.ts";
import type { PointInTimeRepository } from "../pit/repository.ts";
import type { ArtifactStore, VerifyResult } from "./store.ts";

/**
 * Operational artifact verification (docs/DATA_PROVENANCE_SPEC.md sections 7 and 8): check a deterministic
 * sample of the store, and for every artifact that is missing, corrupt, or undecodable, append an
 * ARTIFACT_MISSING correction to every observation that references it so the decision query excludes those
 * rows from that instant on, then record the incident in the ledger. This is the only entry point jobs and
 * the CLI should call; `ArtifactStore.verify` alone reports and quarantines nothing.
 */
export type ArtifactVerificationReport = {
  total: number;
  checked: number;
  failed: VerifyResult[];
  /** Observation rows newly excluded from decisions by this run (0 when every failure was already quarantined). */
  rowsExcluded: number;
  diskUsageBytes: number;
  at: UtcInstant;
};

export type VerifyArtifactsDeps = { store: ArtifactStore; repo: PointInTimeRepository; ledger: Ledger; clock?: (() => number) | undefined };

export const ARTIFACT_INTEGRITY_EVENT = "artifact.integrity_failed";

export function verifyArtifacts(deps: VerifyArtifactsDeps, opts: { sample?: number | undefined; offset?: number | undefined } = {}): ArtifactVerificationReport {
  const sample = opts.sample ?? 100;
  if (!Number.isInteger(sample) || sample <= 0) throw new RangeError(`sample must be a positive integer, got ${sample}`);
  const at = nowUtc(deps.clock ?? Date.now);
  const results = deps.store.verifySample(sample, opts.offset ?? 0);
  const failed = results.filter((r) => !r.ok);
  let rowsExcluded = 0;
  for (const f of failed) {
    const n = deps.repo.markArtifactMissing(f.hash, at);
    rowsExcluded += n;
    // Log the first detection of each failing artifact and every run that newly excludes rows; a permanently
    // corrupt artifact that was fully quarantined earlier does not re-log on every daily run.
    const reportedBefore = deps.ledger.events().some((e) => e.kind === ARTIFACT_INTEGRITY_EVENT && (e.payload as { hash?: unknown }).hash === f.hash);
    if (n > 0 || !reportedBefore) deps.ledger.append(ARTIFACT_INTEGRITY_EVENT, { hash: f.hash, reason: f.reason ?? "unknown", rowsExcluded: n }, at);
  }
  return { total: deps.store.count(), checked: results.length, failed, rowsExcluded, diskUsageBytes: deps.store.diskUsageBytes(), at };
}
