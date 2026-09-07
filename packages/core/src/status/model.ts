import type { Db, IsoDate, UtcInstant } from "@blackgold/shared";
import type { HealthReport } from "../health/health.ts";

/**
 * Everything the read-only status page shows, gathered from the local store in one pass.
 *
 * Separated from rendering so the numbers can be tested without parsing HTML, and so a future JSON endpoint
 * or CLI report can present the same values rather than recomputing them differently. Nothing here reads a
 * broker, a model provider, or the network.
 *
 * Two rules constrain what may appear on this type, both from `docs/THREAT_MODEL.md`:
 *
 * - No dollar totals and no account references. A3 (household financial picture) and T-22 keep those off any
 *   surface that leaves the device, and a page served over Tailscale to a phone is such a surface. Counts,
 *   dates, hashes and states only.
 * - No secret-shaped values. Source ids are names like `fred.` and `sec.`, never keys.
 */
export type StatusReport = {
  health: HealthReport;
  jobs: JobStatus[];
  data: DataCoverage;
  evidence: EvidenceStatus;
  /** Absent when the store has no ledger events at all, which is how a fresh install looks. */
  firstEventAt: UtcInstant | undefined;
};

export type JobStatus = {
  jobId: string;
  name: string;
  scheduleKind: string;
  enabled: boolean;
  lastStatus: string | undefined;
  lastScheduledFor: UtcInstant | undefined;
  lastFinishedAt: UtcInstant | undefined;
  /** Truncated; a full error belongs in the ledger and the logs, not on a status page. */
  lastError: string | undefined;
  missedCount: number;
  failedCount: number;
};

export type SourceCoverage = {
  /** Source id prefix, e.g. `fred.` or `sec.` - a name, never a credential. */
  sourceId: string;
  observations: number;
  earliestAvailableAt: UtcInstant | undefined;
  latestAvailableAt: UtcInstant | undefined;
  latestIngestedAt: UtcInstant | undefined;
};

export type DataCoverage = {
  observations: number;
  sources: SourceCoverage[];
  entities: number;
  snapshots: number;
  artifacts: number;
  artifactBytesCompressed: number;
};

/**
 * Research state, phrased so the page cannot imply evidence that does not exist.
 *
 * `EXPERIMENT_PROTOCOL.md` makes viewing results and opening the holdout irreversible, so both are surfaced:
 * an operator should be able to see at a glance that a holdout is still sealed, and equally that it is not.
 */
export type EvidenceStatus = {
  experiments: number;
  trials: number;
  resultsViewed: number;
  holdoutsOpened: number;
  promotionEvidenceClaimed: number;
};

type JobRow = { job_id: string; name: string; schedule_kind: string; enabled: number };
type RunRow = { job_id: string; status: string; scheduled_for: string; finished_at: string | null; error: string | null };
type CountRow = { n: number };

const MAX_ERROR_CHARS = 160;

export function buildStatusReport(db: Db, health: HealthReport): StatusReport {
  return {
    health,
    jobs: readJobs(db),
    data: readDataCoverage(db),
    evidence: readEvidence(db),
    firstEventAt: firstEventAt(db),
  };
}

function readJobs(db: Db): JobStatus[] {
  const jobs = db.prepare("SELECT job_id, name, schedule_kind, enabled FROM jobs ORDER BY job_id").all() as JobRow[];
  return jobs.map((j) => {
    // Most recent run by scheduled instant. A run that never started has no finished_at, which is why the
    // ordering key is scheduled_for rather than a timestamp that can be null.
    const last = db
      .prepare(
        "SELECT job_id, status, scheduled_for, finished_at, error FROM job_runs WHERE job_id = ? ORDER BY scheduled_for DESC LIMIT 1",
      )
      .get(j.job_id) as RunRow | undefined;
    const missed = db.prepare("SELECT COUNT(*) AS n FROM job_runs WHERE job_id = ? AND status = 'missed'").get(j.job_id) as CountRow;
    const failed = db.prepare("SELECT COUNT(*) AS n FROM job_runs WHERE job_id = ? AND status = 'failed'").get(j.job_id) as CountRow;
    return {
      jobId: j.job_id,
      name: j.name,
      scheduleKind: j.schedule_kind,
      enabled: j.enabled === 1,
      lastStatus: last?.status,
      lastScheduledFor: last?.scheduled_for as UtcInstant | undefined,
      lastFinishedAt: (last?.finished_at ?? undefined) as UtcInstant | undefined,
      lastError: last?.error ? truncate(last.error, MAX_ERROR_CHARS) : undefined,
      missedCount: missed.n,
      failedCount: failed.n,
    };
  });
}

function readDataCoverage(db: Db): DataCoverage {
  // Group by the source-id prefix up to and including the first dot, matching how processing delays are keyed
  // in config. Without the grouping every FRED series would be its own row and the page would be unreadable.
  const sources = db
    .prepare(
      `SELECT
         CASE WHEN instr(source_id, '.') > 0 THEN substr(source_id, 1, instr(source_id, '.')) ELSE source_id END AS sourceId,
         COUNT(*) AS observations,
         MIN(available_at) AS earliest,
         MAX(available_at) AS latest,
         MAX(ingested_at) AS ingested
       FROM observations GROUP BY sourceId ORDER BY sourceId`,
    )
    .all() as { sourceId: string; observations: number; earliest: string | null; latest: string | null; ingested: string | null }[];
  const one = (sql: string): number => (db.prepare(sql).get() as CountRow).n;
  return {
    observations: one("SELECT COUNT(*) AS n FROM observations"),
    sources: sources.map((s) => ({
      sourceId: s.sourceId,
      observations: s.observations,
      earliestAvailableAt: (s.earliest ?? undefined) as UtcInstant | undefined,
      latestAvailableAt: (s.latest ?? undefined) as UtcInstant | undefined,
      latestIngestedAt: (s.ingested ?? undefined) as UtcInstant | undefined,
    })),
    entities: one("SELECT COUNT(DISTINCT entity_id) AS n FROM observations WHERE entity_id IS NOT NULL"),
    snapshots: one("SELECT COUNT(*) AS n FROM pit_snapshots"),
    artifacts: one("SELECT COUNT(*) AS n FROM artifacts"),
    artifactBytesCompressed: (db.prepare("SELECT COALESCE(SUM(bytes_compressed), 0) AS n FROM artifacts").get() as CountRow).n,
  };
}

function readEvidence(db: Db): EvidenceStatus {
  const one = (sql: string): number => (db.prepare(sql).get() as CountRow).n;
  return {
    experiments: one("SELECT COUNT(*) AS n FROM experiments"),
    trials: one("SELECT COUNT(*) AS n FROM trial_ledger"),
    resultsViewed: one("SELECT COUNT(*) AS n FROM experiments WHERE results_viewed_at IS NOT NULL"),
    holdoutsOpened: one("SELECT COUNT(*) AS n FROM experiments WHERE holdout_opened_at IS NOT NULL"),
    promotionEvidenceClaimed: one("SELECT COUNT(*) AS n FROM experiments WHERE promotion_evidence_at IS NOT NULL"),
  };
}

function firstEventAt(db: Db): UtcInstant | undefined {
  const row = db.prepare("SELECT MIN(at) AS at FROM ledger_events").get() as { at: string | null };
  return (row.at ?? undefined) as UtcInstant | undefined;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Days a date is behind `now`, floored at 0. Used to age-flag the last seal and the newest data. */
export function daysBehind(now: UtcInstant, date: IsoDate | UtcInstant | undefined): number | undefined {
  if (date === undefined) return undefined;
  const then = Date.parse(date.length === 10 ? `${date}T00:00:00.000Z` : date);
  const diff = Math.floor((Date.parse(now) - then) / 86_400_000);
  return diff < 0 ? 0 : diff;
}
