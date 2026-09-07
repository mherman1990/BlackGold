import { compareInstants, epochMs, hashJson, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { AsOfQuery, AsOfResult, ReadOnlyPointInTime, StoredObservation } from "../data/pit/types.ts";
import type { PointInTimeRepository } from "../data/pit/repository.ts";

/**
 * Leakage audit (PLAN.md Phase 2).
 *
 * The point-in-time repository already refuses a future observation, so this is a deliberate second,
 * independent check on the same invariant, written from the rule rather than from the implementation:
 * `availableAt + processingDelay <= decisionAt` for every row a run consumed. A single implementation
 * enforcing its own correctness is not evidence; two agreeing is.
 *
 * The audit also catches faults the repository structurally cannot see, because it knows nothing about
 * what a strategy did with a row:
 *
 *  - a decision that read a bar for a session later than its own decision date (a future price, correctly
 *    dated and correctly available, but still not knowable when the decision was taken);
 *  - a run whose declared processing delay is zero, which is a labelled assumption, not an error;
 *  - a run that read the same source at a decision instant earlier than one it already read at, which
 *    means the decision loop went backwards in time and could carry state forward.
 *
 * Wrap a repository with `auditReads` and hand the wrapper to the feature engine. The wrapper is read-only:
 * it exposes `asOf` and nothing that writes.
 */

export const LEAKAGE_VIOLATION_KINDS = [
  /** `availableAt + processingDelay > decisionAt`: the row was not published in time. */
  "FUTURE_AVAILABILITY",
  /** The row's effective session is later than the decision's own session. */
  "FUTURE_EFFECTIVE_SESSION",
  /** A read at an instant earlier than an instant already read for the same source. */
  "NON_MONOTONIC_DECISION_ORDER",
  /** A read that declared no processing delay while the source has a non-zero default. */
  "ZERO_DECLARED_DELAY",
] as const;
export type LeakageViolationKind = (typeof LEAKAGE_VIOLATION_KINDS)[number];

export type LeakageViolation = {
  kind: LeakageViolationKind;
  sourceId: string;
  entityId: string | undefined;
  decisionAt: UtcInstant;
  observationId: number | undefined;
  availableAt: UtcInstant | undefined;
  processingDelayMs: number;
  detail: string;
};

export type ReadRecord = {
  sourceId: string;
  entityId: string | undefined;
  decisionAt: UtcInstant;
  processingDelayMs: number;
  snapshotId: string | undefined;
  rowCount: number;
  /** Newest `availableAt` among the returned rows, for the margin statistics. */
  newestAvailableAt: UtcInstant | undefined;
  labels: string[];
};

export type LeakageReport = {
  reads: number;
  rowsReturned: number;
  violations: LeakageViolation[];
  /** Distinct source ids the run read. */
  sources: string[];
  /** Union of every read-path label. A run must carry these. */
  labels: string[];
  /**
   * Smallest observed `decisionAt - (availableAt + delay)` across every row, in milliseconds. Zero means a
   * decision used a row that became available at the exact instant it was allowed to. Negative is impossible
   * without a violation.
   */
  minMarginMs: number | undefined;
  /** Sources read with a declared delay of zero. Each makes the run OPTIMISTIC_DELAY. */
  zeroDelaySources: string[];
  clean: boolean;
  /** Hash of the report body, so a PR can cite an exact audit result. */
  reportHash: string;
};

export class LeakageAuditor implements ReadOnlyPointInTime {
  private readonly inner: ReadOnlyPointInTime;
  private readonly records: ReadRecord[] = [];
  private readonly violations: LeakageViolation[] = [];
  private readonly latestBySource = new Map<string, UtcInstant>();
  private readonly delayOf: (sourceId: string) => number;
  private minMargin: number | undefined;
  private rows = 0;

  constructor(inner: ReadOnlyPointInTime, opts: { defaultDelayMs?: (sourceId: string) => number } = {}) {
    this.inner = inner;
    this.delayOf = opts.defaultDelayMs ?? ((): number => 0);
  }

  asOf<T = unknown>(query: AsOfQuery): AsOfResult<T> {
    const result = this.inner.asOf<T>(query);
    const delay = result.processingDelayMs;
    const decisionMs = epochMs(query.decisionAt);

    // Monotonicity: a research loop walks decision instants forward. Going backwards for the same source
    // means state from a later decision could already be in memory.
    const previous = this.latestBySource.get(query.sourceId);
    if (previous !== undefined && compareInstants(query.decisionAt, previous) < 0) {
      this.violations.push({
        kind: "NON_MONOTONIC_DECISION_ORDER",
        sourceId: query.sourceId,
        entityId: query.entityId,
        decisionAt: query.decisionAt,
        observationId: undefined,
        availableAt: undefined,
        processingDelayMs: delay,
        detail: `read at ${query.decisionAt} after already reading ${query.sourceId} at ${previous}`,
      });
    } else {
      this.latestBySource.set(query.sourceId, query.decisionAt);
    }

    if (delay === 0 && this.delayOf(query.sourceId) > 0) {
      this.violations.push({
        kind: "ZERO_DECLARED_DELAY",
        sourceId: query.sourceId,
        entityId: query.entityId,
        decisionAt: query.decisionAt,
        observationId: undefined,
        availableAt: undefined,
        processingDelayMs: 0,
        detail: `declared delay 0 for ${query.sourceId} whose default is ${this.delayOf(query.sourceId)} ms`,
      });
    }

    let newest: UtcInstant | undefined;
    for (const row of result.rows) {
      this.rows++;
      const margin = decisionMs - (epochMs(row.availableAt) + delay);
      if (margin < 0) {
        this.violations.push({
          kind: "FUTURE_AVAILABILITY",
          sourceId: query.sourceId,
          entityId: row.entityId,
          decisionAt: query.decisionAt,
          observationId: row.id,
          availableAt: row.availableAt,
          processingDelayMs: delay,
          detail: `availableAt ${row.availableAt} plus ${delay} ms delay exceeds decisionAt ${query.decisionAt} by ${-margin} ms`,
        });
      }
      if (this.minMargin === undefined || margin < this.minMargin) this.minMargin = margin;
      if (newest === undefined || compareInstants(row.availableAt, newest) > 0) newest = row.availableAt;
    }

    this.records.push({
      sourceId: query.sourceId,
      entityId: query.entityId,
      decisionAt: query.decisionAt,
      processingDelayMs: delay,
      snapshotId: query.snapshotId,
      rowCount: result.rows.length,
      newestAvailableAt: newest,
      labels: [...result.labels],
    });
    return result;
  }

  /**
   * Independently check that no row carries an effective session later than the decision's own session.
   * The repository cannot do this: it does not know which calendar date a decision belongs to.
   */
  checkEffectiveSessions(decisionSessions: ReadonlyMap<string, IsoDate>, rowsBySource: ReadonlyMap<string, readonly StoredObservation[]>): void {
    for (const [key, rows] of rowsBySource) {
      const session = decisionSessions.get(key);
      if (session === undefined) continue;
      for (const row of rows) {
        const effective = row.effectiveAt?.slice(0, 10);
        if (effective !== undefined && effective > session) {
          this.violations.push({
            kind: "FUTURE_EFFECTIVE_SESSION",
            sourceId: row.sourceId,
            entityId: row.entityId,
            decisionAt: row.availableAt,
            observationId: row.id,
            availableAt: row.availableAt,
            processingDelayMs: 0,
            detail: `row effective ${effective} is later than decision session ${session}`,
          });
        }
      }
    }
  }

  reads(): readonly ReadRecord[] {
    return this.records;
  }

  report(): LeakageReport {
    const sources = [...new Set(this.records.map((r) => r.sourceId))].sort();
    const labels = [...new Set(this.records.flatMap((r) => r.labels))].sort();
    const zeroDelaySources = [...new Set(this.records.filter((r) => r.processingDelayMs === 0).map((r) => r.sourceId))].sort();
    const body = {
      reads: this.records.length,
      rowsReturned: this.rows,
      violations: this.violations,
      sources,
      labels,
      minMarginMs: this.minMargin,
      zeroDelaySources,
    };
    return { ...body, clean: this.violations.length === 0, reportHash: `sha256:${hashJson(body)}` };
  }
}

/** Wrap a repository so a research run can only read, and every read is audited. */
export function auditReads(repo: PointInTimeRepository, opts: { defaultDelayMs?: (sourceId: string) => number } = {}): LeakageAuditor {
  return new LeakageAuditor({ asOf: (q) => repo.asOf(q) }, opts);
}
