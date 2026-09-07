import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { epochMs, utc, type Db, type UtcInstant } from "@blackgold/shared";
import { Ledger, NyseCalendar, Scheduler, openCoreDb, type JobDefinition } from "../src/index.ts";

const HOUR = 3_600_000;

function rig(now: UtcInstant, dbPath?: string): { db: Db; scheduler: Scheduler; ledger: Ledger; path: string } {
  const path = dbPath ?? join(mkdtempSync(join(tmpdir(), "bg-sched-")), "s.sqlite");
  const db = openCoreDb({ dbPath: path }).db;
  const ledger = new Ledger(db, () => epochMs(now));
  const scheduler = new Scheduler({
    db,
    ledger,
    calendar: new NyseCalendar(),
    clock: () => epochMs(now),
    dueLookbackMs: 2 * HOUR,
    missedLookbackMs: 48 * HOUR,
  });
  return { db, scheduler, ledger, path };
}

function job(overrides: Partial<JobDefinition> & { onRun?: () => void }): JobDefinition {
  const { onRun, ...rest } = overrides;
  return {
    jobId: "j1",
    name: "test job",
    schedule: { kind: "daily_utc", hh: 21, mm: 0 },
    deadlineMs: 5_000,
    handler: () => {
      onRun?.();
    },
    ...rest,
  };
}

// Tuesday 2026-09-08, 21:30Z: the 21:00Z daily job and the post-close job (close 20:00Z EDT + 60 min) are due.
const NOW = utc("2026-09-08T21:30:00Z");

describe("Scheduler", () => {
  it("runs a due job once; a second tick and a fresh instance over the same db both skip it", async () => {
    let runs = 0;
    const a = rig(NOW);
    a.scheduler.register(job({ onRun: () => runs++ }));
    const first = await a.scheduler.tick(NOW);
    expect(first.map((o) => o.status)).toEqual(["succeeded"]);
    const second = await a.scheduler.tick(NOW);
    expect(second.map((o) => o.status)).toEqual(["skipped_duplicate"]);
    a.db.close();

    const b = rig(NOW, a.path); // reboot: new process, same database
    b.scheduler.register(job({ onRun: () => runs++ }));
    const third = await b.scheduler.tick(NOW);
    expect(third.map((o) => o.status)).toEqual(["skipped_duplicate"]);
    expect(runs).toBe(1);
    expect(b.ledger.events().map((e) => e.kind)).toEqual(["job.started", "job.finished"]);
    b.db.close();
  });

  it("idempotency key is a pure function of job id and scheduled instant", () => {
    const a = rig(NOW);
    a.scheduler.register(job({}));
    const [x] = a.scheduler.computeDueRuns(NOW);
    const [y] = a.scheduler.computeDueRuns(NOW);
    expect(x?.idempotencyKey).toBe(y?.idempotencyKey);
    expect(x?.scheduledFor).toBe("2026-09-08T21:00:00.000Z");
    a.db.close();
  });

  it("after_close runs derive from the exchange calendar: none on a holiday, correct offset on a session", () => {
    const a = rig(NOW);
    a.scheduler.register(job({ jobId: "post", schedule: { kind: "after_close", offsetMs: 60 * 60_000 } }));
    expect(a.scheduler.computeDueRuns(NOW).map((r) => r.scheduledFor)).toEqual(["2026-09-08T21:00:00.000Z"]);
    // Labor Day 2026-09-07: no session, so no run in a window that covers only that day's would-be close.
    const holidayEvening = utc("2026-09-07T21:30:00Z");
    expect(a.scheduler.computeDueRuns(holidayEvening)).toEqual([]);
    // Early close 2026-11-27 (13:00 ET = 18:00Z): run at 19:00Z.
    expect(a.scheduler.computeDueRuns(utc("2026-11-27T19:30:00Z")).map((r) => r.scheduledFor)).toEqual(["2026-11-27T19:00:00.000Z"]);
    a.db.close();
  });

  it("a handler that exceeds its deadline is recorded as failed and the ledger says so", async () => {
    const a = rig(NOW);
    a.scheduler.register(
      job({
        deadlineMs: 20,
        handler: (ctx) =>
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 500);
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            });
          }),
      }),
    );
    const out = await a.scheduler.tick(NOW);
    expect(out[0]?.status).toBe("failed");
    expect(out[0]?.error).toMatch(/DeadlineExceededError/);
    const finished = a.ledger.events().find((e) => e.kind === "job.finished");
    expect((finished?.payload as { status: string }).status).toBe("failed");
    a.db.close();
  });

  it("detects never-recorded and stale runs as missed and writes ledger events", async () => {
    const a = rig(NOW);
    a.scheduler.register(job({}));
    // Yesterday's 21:00Z run was never recorded (outside the due window, inside the missed window).
    const missed = a.scheduler.detectMissedRuns(NOW);
    expect(missed.map((m) => [m.scheduledFor, m.reason])).toEqual([["2026-09-07T21:00:00.000Z", "never_recorded"]]);
    expect(a.scheduler.detectMissedRuns(NOW)).toEqual([]); // idempotent
    // A run that was claimed but never finished becomes stale once its deadline passes.
    a.db.prepare("INSERT INTO job_runs (idempotency_key, job_id, scheduled_for, status, attempt, started_at) VALUES ('stuck', 'j1', ?, 'running', 1, ?)").run(
      "2026-09-08T19:00:00.000Z",
      "2026-09-08T19:00:00.000Z",
    );
    const stale = a.scheduler.detectMissedRuns(NOW);
    expect(stale.map((m) => m.reason)).toEqual(["stale_running"]);
    expect(a.ledger.events().filter((e) => e.kind === "job.missed")).toHaveLength(2);
    await a.scheduler.tick(NOW);
    a.db.close();
  });
});
