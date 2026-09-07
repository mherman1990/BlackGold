import {
  addDays,
  canonicalJson,
  dateOfInstantInZone,
  deterministicId,
  epochMs,
  utc,
  type Db,
  type IsoDate,
  type UtcInstant,
} from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import type { Ledger } from "../ledger/ledger.ts";

/**
 * Deterministic job scheduler. Scheduled instants derive from the exchange calendar (or fixed UTC rules),
 * never from wall-clock cron (R-07). Every run has an idempotency key that is a pure function of
 * (jobId, scheduledFor); the job_runs primary key makes duplicate execution impossible across ticks,
 * processes, and reboots. Every lifecycle transition is written to the ledger.
 */

export type ScheduleSpec =
  | { kind: "after_close"; offsetMs: number }
  | { kind: "before_open"; offsetMs: number }
  | { kind: "daily_utc"; hh: number; mm: number }
  | { kind: "interval"; everyMs: number };

export type JobContext = {
  jobId: string;
  idempotencyKey: string;
  scheduledFor: UtcInstant;
  now: UtcInstant;
  signal: AbortSignal;
  db: Db;
  ledger: Ledger;
};

export type JobDefinition = {
  jobId: string;
  name: string;
  schedule: ScheduleSpec;
  /** Maximum handler duration; also how long a run may stay pending before it counts as missed. */
  deadlineMs: number;
  handler: (ctx: JobContext) => Promise<void> | void;
};

export type DueRun = { jobId: string; scheduledFor: UtcInstant; idempotencyKey: string };

export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "missed" | "skipped_duplicate";

export type RunOutcome = DueRun & { status: "succeeded" | "failed" | "skipped_duplicate"; error?: string };

export type MissedRun = DueRun & { reason: "never_recorded" | "stale_pending" | "stale_running" };

export type SchedulerOptions = {
  db: Db;
  ledger: Ledger;
  calendar: ExchangeCalendar;
  clock?: () => number;
  /** How far back tick() looks for due runs. Older instants are the missed-run detector's business. */
  dueLookbackMs?: number;
  /** How far back detectMissedRuns() looks for instants with no run row. */
  missedLookbackMs?: number;
};

export class DeadlineExceededError extends Error {
  constructor(jobId: string, deadlineMs: number) {
    super(`Job ${jobId} exceeded its deadline of ${deadlineMs} ms`);
    this.name = "DeadlineExceededError";
  }
}

export function runIdempotencyKey(jobId: string, scheduledFor: UtcInstant): string {
  return deterministicId("run", jobId, scheduledFor);
}

type RunRow = { idempotency_key: string; job_id: string; scheduled_for: string; started_at: string | null; status: RunStatus };

export class Scheduler {
  private readonly db: Db;
  private readonly ledger: Ledger;
  private readonly calendar: ExchangeCalendar;
  private readonly clock: () => number;
  private readonly dueLookbackMs: number;
  private readonly missedLookbackMs: number;
  private readonly jobs = new Map<string, JobDefinition>();

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.ledger = options.ledger;
    this.calendar = options.calendar;
    this.clock = options.clock ?? Date.now;
    this.dueLookbackMs = options.dueLookbackMs ?? 15 * 60_000;
    this.missedLookbackMs = options.missedLookbackMs ?? 24 * 3_600_000;
    if (this.missedLookbackMs < this.dueLookbackMs) throw new RangeError("missedLookbackMs must be >= dueLookbackMs");
  }

  register(job: JobDefinition): void {
    if (this.jobs.has(job.jobId)) throw new Error(`Job ${job.jobId} is already registered`);
    if (!Number.isInteger(job.deadlineMs) || job.deadlineMs <= 0) throw new RangeError("deadlineMs must be a positive integer");
    validateSchedule(job.schedule);
    this.jobs.set(job.jobId, job);
    this.db
      .prepare(
        "INSERT INTO jobs (job_id, name, schedule_kind, spec, deadline_ms, enabled) VALUES (?, ?, ?, ?, ?, 1) " +
          "ON CONFLICT(job_id) DO UPDATE SET name = excluded.name, schedule_kind = excluded.schedule_kind, " +
          "spec = excluded.spec, deadline_ms = excluded.deadline_ms, enabled = 1",
      )
      .run(job.jobId, job.name, job.schedule.kind, canonicalJson(job.schedule), job.deadlineMs);
  }

  registeredJobs(): readonly JobDefinition[] {
    return [...this.jobs.values()];
  }

  now(): UtcInstant {
    return utc(this.clock());
  }

  /** Scheduled instants in (now - lookbackMs, now], for every registered job, ascending by instant. */
  computeDueRuns(now: UtcInstant, lookbackMs: number = this.dueLookbackMs): DueRun[] {
    const out: DueRun[] = [];
    for (const job of this.jobs.values()) {
      for (const scheduledFor of this.scheduledInstants(job.schedule, now, lookbackMs)) {
        out.push({ jobId: job.jobId, scheduledFor, idempotencyKey: runIdempotencyKey(job.jobId, scheduledFor) });
      }
    }
    return out.sort((a, b) => epochMs(a.scheduledFor) - epochMs(b.scheduledFor) || a.jobId.localeCompare(b.jobId));
  }

  /** Instants for one schedule within (windowStart, now]. Pure function of the schedule, calendar, and window. */
  scheduledInstants(schedule: ScheduleSpec, now: UtcInstant, lookbackMs: number): UtcInstant[] {
    const nowMs = epochMs(now);
    const startMs = nowMs - lookbackMs;
    const inWindow = (ms: number): boolean => ms > startMs && ms <= nowMs;
    const out: number[] = [];
    switch (schedule.kind) {
      case "interval": {
        const first = Math.floor(startMs / schedule.everyMs) * schedule.everyMs;
        for (let t = first; t <= nowMs; t += schedule.everyMs) if (inWindow(t)) out.push(t);
        break;
      }
      case "daily_utc": {
        for (const date of utcDatesCovering(startMs, nowMs)) {
          const t = Date.parse(`${date}T${pad(schedule.hh)}:${pad(schedule.mm)}:00.000Z`);
          if (inWindow(t)) out.push(t);
        }
        break;
      }
      case "after_close":
      case "before_open": {
        const from = addDays(dateOfInstantInZone(utc(startMs), this.calendar.timeZone), -1);
        const to = addDays(dateOfInstantInZone(now, this.calendar.timeZone), 1);
        for (const date of this.calendar.sessionDates(from, to)) {
          const t =
            schedule.kind === "after_close"
              ? epochMs(this.calendar.sessionClose(date)) + schedule.offsetMs
              : epochMs(this.calendar.sessionOpen(date)) - schedule.offsetMs;
          if (inWindow(t)) out.push(t);
        }
        break;
      }
    }
    return out.sort((a, b) => a - b).map((ms) => utc(ms));
  }

  /**
   * One scheduler pass: claim each due run by inserting its job_runs row (the primary key rejects a
   * duplicate atomically), then execute claimed handlers sequentially under their deadlines.
   */
  async tick(now: UtcInstant = this.now()): Promise<RunOutcome[]> {
    const outcomes: RunOutcome[] = [];
    for (const due of this.computeDueRuns(now)) {
      const job = this.jobs.get(due.jobId);
      if (!job) continue;
      const claimed = this.claim(due);
      if (!claimed) {
        outcomes.push({ ...due, status: "skipped_duplicate" });
        continue;
      }
      outcomes.push(await this.execute(job, due, now));
    }
    return outcomes;
  }

  /**
   * Mark as missed: (1) instants in (now - missedLookbackMs, now - dueLookbackMs] with no run row, and
   * (2) pending/running rows whose deadline has passed. Returns them so the caller can notify.
   */
  detectMissedRuns(now: UtcInstant = this.now()): MissedRun[] {
    const missed: MissedRun[] = [];
    const nowMs = epochMs(now);
    const cutoff = utc(nowMs - this.dueLookbackMs);
    const exists = this.db.prepare("SELECT 1 AS one FROM job_runs WHERE idempotency_key = ?");
    for (const job of this.jobs.values()) {
      for (const scheduledFor of this.scheduledInstants(job.schedule, cutoff, this.missedLookbackMs - this.dueLookbackMs)) {
        const key = runIdempotencyKey(job.jobId, scheduledFor);
        if (exists.get(key) !== undefined) continue;
        const run: MissedRun = { jobId: job.jobId, scheduledFor, idempotencyKey: key, reason: "never_recorded" };
        this.db.transaction(() => {
          this.db
            .prepare("INSERT INTO job_runs (idempotency_key, job_id, scheduled_for, status, attempt, error) VALUES (?, ?, ?, 'missed', 0, ?)")
            .run(key, job.jobId, scheduledFor, "never_recorded");
          this.ledger.append("job.missed", { ...run, detectedAt: now }, now);
        });
        missed.push(run);
      }
    }
    const stale = this.db
      .prepare("SELECT idempotency_key, job_id, scheduled_for, started_at, status FROM job_runs WHERE status IN ('pending','running')")
      .all() as RunRow[];
    for (const row of stale) {
      const job = this.jobs.get(row.job_id);
      const deadlineMs = job?.deadlineMs ?? this.storedDeadline(row.job_id);
      const anchor = Date.parse(row.started_at ?? row.scheduled_for);
      if (anchor + deadlineMs >= nowMs) continue;
      const reason = row.status === "running" ? "stale_running" : "stale_pending";
      const run: MissedRun = {
        jobId: row.job_id,
        scheduledFor: row.scheduled_for as UtcInstant,
        idempotencyKey: row.idempotency_key,
        reason,
      };
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE job_runs SET status = 'missed', finished_at = ?, error = ? WHERE idempotency_key = ?")
          .run(now, reason, row.idempotency_key);
        this.ledger.append("job.missed", { ...run, detectedAt: now }, now);
      });
      missed.push(run);
    }
    return missed;
  }

  runs(jobId?: string): RunRow[] {
    return (
      jobId === undefined
        ? this.db.prepare("SELECT idempotency_key, job_id, scheduled_for, started_at, status FROM job_runs ORDER BY scheduled_for").all()
        : this.db
            .prepare("SELECT idempotency_key, job_id, scheduled_for, started_at, status FROM job_runs WHERE job_id = ? ORDER BY scheduled_for")
            .all(jobId)
    ) as RunRow[];
  }

  private storedDeadline(jobId: string): number {
    const row = this.db.prepare("SELECT deadline_ms FROM jobs WHERE job_id = ?").get(jobId) as { deadline_ms: number } | undefined;
    return row?.deadline_ms ?? 0;
  }

  /** Insert the pending row; false when the key already exists (duplicate tick, replay after reboot). */
  private claim(due: DueRun): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare("INSERT OR IGNORE INTO job_runs (idempotency_key, job_id, scheduled_for, status, attempt) VALUES (?, ?, ?, 'pending', 1)")
        .run(due.idempotencyKey, due.jobId, due.scheduledFor);
      return Number(result.changes) === 1;
    });
  }

  private async execute(job: JobDefinition, due: DueRun, now: UtcInstant): Promise<RunOutcome> {
    const startedAt = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE job_runs SET status = 'running', started_at = ? WHERE idempotency_key = ?").run(startedAt, due.idempotencyKey);
      this.ledger.append("job.started", { ...due, startedAt }, startedAt);
    });

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new DeadlineExceededError(job.jobId, job.deadlineMs);
        controller.abort(err);
        reject(err);
      }, job.deadlineMs);
    });

    let status: "succeeded" | "failed" = "succeeded";
    let error: string | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() =>
          job.handler({ ...due, now, signal: controller.signal, db: this.db, ledger: this.ledger }),
        ),
        deadline,
      ]);
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const finishedAt = this.now();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE job_runs SET status = ?, finished_at = ?, error = ? WHERE idempotency_key = ?")
        .run(status, finishedAt, error ?? null, due.idempotencyKey);
      this.ledger.append("job.finished", { ...due, status, error: error ?? null, finishedAt }, finishedAt);
    });
    return error === undefined ? { ...due, status } : { ...due, status, error };
  }
}

function validateSchedule(s: ScheduleSpec): void {
  switch (s.kind) {
    case "interval":
      if (!Number.isInteger(s.everyMs) || s.everyMs <= 0) throw new RangeError("interval.everyMs must be a positive integer");
      return;
    case "daily_utc":
      if (!Number.isInteger(s.hh) || s.hh < 0 || s.hh > 23) throw new RangeError("daily_utc.hh must be 0-23");
      if (!Number.isInteger(s.mm) || s.mm < 0 || s.mm > 59) throw new RangeError("daily_utc.mm must be 0-59");
      return;
    case "after_close":
    case "before_open":
      if (!Number.isInteger(s.offsetMs) || s.offsetMs < 0) throw new RangeError(`${s.kind}.offsetMs must be a non-negative integer`);
      return;
  }
}

function utcDatesCovering(startMs: number, endMs: number): IsoDate[] {
  const out: IsoDate[] = [];
  const first = addDays(dateOfInstantInZone(utc(startMs), "UTC"), -1);
  const last = dateOfInstantInZone(utc(endMs), "UTC");
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
