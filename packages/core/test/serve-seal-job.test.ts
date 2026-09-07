import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { epochMs, isoDate, utc, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { Ledger, NyseCalendar, Scheduler, SealedDateAppendError, SEAL_GRACE_DAYS, openCoreDb, registerPhase0Jobs, runHealth, sealThroughDate } from "../src/index.ts";

/**
 * The scheduled ledger seal (Codex finding on PR #8).
 *
 * `PLAN.md` lists "append-only hash-chained ledger with daily seal" as a Phase 0 deliverable, but until this
 * job existed `sealDaily()` was reachable only from the `seal` CLI, so an Umbrel install running
 * `core ... serve` accumulated unsealed days forever. These tests pin the behaviour that closes that, and in
 * particular the catch-up case: the scheduler records a run it could not perform as `missed` rather than
 * running it late, so without a backlog sweep a powered-off Pi would leave days permanently unsealed.
 */

const HOUR = 3_600_000;

function rig(now: UtcInstant, dbPath?: string): { db: Db; scheduler: Scheduler; ledger: Ledger; path: string } {
  const path = dbPath ?? join(mkdtempSync(join(tmpdir(), "bg-seal-")), "s.sqlite");
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
  registerPhase0Jobs(scheduler);
  return { db, scheduler, ledger, path };
}

const D = (s: string): IsoDate => isoDate(s);

describe("registerPhase0Jobs", () => {
  it("registers the seal job alongside the heartbeat", () => {
    const { scheduler } = rig(utc("2026-09-07T00:05:00Z"));
    const ids = scheduler.registeredJobs().map((j) => j.jobId).sort();
    expect(ids).toContain("heartbeat");
    expect(ids).toContain("seal_ledger");
  });

  it("schedules the seal after the heartbeat so the two never share an instant", () => {
    const { scheduler } = rig(utc("2026-09-07T00:05:00Z"));
    const heartbeat = scheduler.registeredJobs().find((j) => j.jobId === "heartbeat");
    const seal = scheduler.registeredJobs().find((j) => j.jobId === "seal_ledger");
    expect(heartbeat?.schedule).toEqual({ kind: "daily_utc", hh: 0, mm: 0 });
    expect(seal?.schedule).toEqual({ kind: "daily_utc", hh: 0, mm: 5 });
  });
});

describe("the seal job", () => {
  it("seals yesterday when the service has been running normally", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-05T00:05:00Z"));
    ledger.append("test.event", { n: 1 }, utc("2026-09-03T12:00:00Z"));
    expect(ledger.seal(D("2026-09-03"))).toBeUndefined();

    await scheduler.tick(utc("2026-09-05T00:05:00Z"));

    const seal = ledger.seal(D("2026-09-03"));
    expect(seal).toBeDefined();
    expect(seal?.rootHash).toBe(ledger.computeDailyRoot(D("2026-09-03")).rootHash);
  });

  it("never seals today or the grace day, only days past the grace window", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-05T00:05:00Z"));
    ledger.append("test.event", { n: 1 }, utc("2026-09-03T12:00:00Z"));
    ledger.append("test.event", { n: 2 }, utc("2026-09-04T12:00:00Z"));
    ledger.append("test.event", { n: 3 }, utc("2026-09-05T00:00:30Z"));

    await scheduler.tick(utc("2026-09-05T00:05:00Z"));

    expect(ledger.seal(D("2026-09-03"))).toBeDefined();
    // Today is still open; sealing it would freeze a root that later events would contradict.
    expect(ledger.seal(D("2026-09-05"))).toBeUndefined();
    // And so is yesterday: the grace day exists so a job that captured a timestamp and appends hours later
    // cannot land inside a day that has already been sealed shut.
    expect(ledger.seal(D("2026-09-04"))).toBeUndefined();
  });

  it("catches up the whole backlog after the appliance was powered off", async () => {
    // Events across four days, nothing sealed: the Pi was off and every run was recorded missed.
    const { ledger, scheduler } = rig(utc("2026-09-07T00:05:00Z"));
    for (const day of ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]) {
      ledger.append("test.event", { day }, utc(`${day}T12:00:00Z`));
    }
    expect(ledger.seals()).toHaveLength(0);

    await scheduler.tick(utc("2026-09-07T00:05:00Z"));

    // One successful run repairs the entire gap.
    const sealedDates = ledger.seals().map((s) => s.date);
    expect(sealedDates).toEqual([D("2026-09-02"), D("2026-09-03"), D("2026-09-04"), D("2026-09-05")]);
    for (const d of sealedDates) {
      expect(ledger.seal(d)?.rootHash).toBe(ledger.computeDailyRoot(d).rootHash);
    }
    expect(ledger.verifySeals().ok).toBe(true);
  });

  it("skips days that have no events, because an empty day has nothing to protect", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-07T00:05:00Z"));
    ledger.append("test.event", { n: 1 }, utc("2026-09-02T12:00:00Z"));
    ledger.append("test.event", { n: 2 }, utc("2026-09-05T12:00:00Z"));

    await scheduler.tick(utc("2026-09-07T00:05:00Z"));

    expect(ledger.seals().map((s) => s.date)).toEqual([D("2026-09-02"), D("2026-09-05")]);
  });

  it("records what it sealed in the ledger itself", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-05T00:05:00Z"));
    ledger.append("test.event", { n: 1 }, utc("2026-09-03T12:00:00Z"));

    await scheduler.tick(utc("2026-09-05T00:05:00Z"));

    const sealEvents = ledger.events().filter((e) => e.kind === "ledger.sealed");
    expect(sealEvents).toHaveLength(1);
    const payload = sealEvents[0]?.payload as { dates: string[]; throughDate: string };
    expect(payload.dates).toEqual(["2026-09-03"]);
    expect(payload.throughDate).toBe("2026-09-03");
  });

  it("writes no seal event when there was nothing to seal", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-05T00:05:00Z"));
    await scheduler.tick(utc("2026-09-05T00:05:00Z"));
    expect(ledger.events().filter((e) => e.kind === "ledger.sealed")).toHaveLength(0);
  });

  it("does nothing on a second run at the same instant", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-05T00:05:00Z"));
    ledger.append("test.event", { n: 1 }, utc("2026-09-03T12:00:00Z"));

    await scheduler.tick(utc("2026-09-05T00:05:00Z"));
    const sealsAfterFirst = ledger.seals().length;
    const eventsAfterFirst = ledger.count();

    // The scheduler's idempotency key already suppresses the duplicate run; sealDaily would be a no-op
    // anyway. Both layers are checked here because either one alone would let a restart double-log.
    await scheduler.tick(utc("2026-09-05T00:05:00Z"));
    expect(ledger.seals()).toHaveLength(sealsAfterFirst);
    expect(ledger.count()).toBe(eventsAfterFirst);
    expect(ledger.verifySeals().ok).toBe(true);
  });

  it("seals its own seal record the following day, leaving no day permanently unsealed", async () => {
    // The job writes a `ledger.sealed` event, which itself becomes an event on the day it ran. If the job
    // ignored that, every run would leave exactly one unsealed day behind it forever. It does not: the next
    // day's run picks it up. Verified across two days on one database.
    const path = join(mkdtempSync(join(tmpdir(), "bg-seal-chain-")), "s.sqlite");
    // Run at 09-05 seals through 09-03 (yesterday less one grace day) and writes its own record on 09-05.
    const first = rig(utc("2026-09-05T00:05:00Z"), path);
    first.ledger.append("test.event", { n: 1 }, utc("2026-09-03T12:00:00Z"));
    await first.scheduler.tick(utc("2026-09-05T00:05:00Z"));
    expect(first.ledger.seals().map((s) => s.date)).toEqual([D("2026-09-03")]);
    // 09-05 now carries the ledger.sealed event and is itself unsealed.
    expect(first.ledger.unsealedDates(D("2026-09-05"))).toEqual([D("2026-09-05")]);
    first.db.close();

    // Two days on, 09-05 is past the grace window, so the next run picks it up.
    const second = rig(utc("2026-09-07T00:05:00Z"), path);
    await second.scheduler.tick(utc("2026-09-07T00:05:00Z"));
    expect(second.ledger.seals().map((s) => s.date)).toEqual([D("2026-09-03"), D("2026-09-05")]);
    expect(second.ledger.verifySeals().ok).toBe(true);
    expect(second.ledger.unsealedDates(D("2026-09-05"))).toEqual([]);
    second.db.close();
  });
});

describe("Ledger.unsealedDates", () => {
  it("returns only dates with events, at or before the cutoff, that have no seal", () => {
    const { ledger } = rig(utc("2026-09-07T00:05:00Z"));
    for (const day of ["2026-09-03", "2026-09-04", "2026-09-07"]) {
      ledger.append("test.event", { day }, utc(`${day}T12:00:00Z`));
    }
    ledger.sealDaily(D("2026-09-03"), utc("2026-09-07T00:05:00Z"));

    expect(ledger.unsealedDates(D("2026-09-06"))).toEqual([D("2026-09-04")]);
    expect(ledger.unsealedDates(D("2026-09-07"))).toEqual([D("2026-09-04"), D("2026-09-07")]);
    expect(ledger.unsealedDates(D("2026-09-02"))).toEqual([]);
  });

  it("lists distinct event dates ascending", () => {
    const { ledger } = rig(utc("2026-09-07T00:05:00Z"));
    ledger.append("a", {}, utc("2026-09-04T23:59:59Z"));
    ledger.append("b", {}, utc("2026-09-04T00:00:00Z"));
    ledger.append("c", {}, utc("2026-09-03T10:00:00Z"));
    expect(ledger.eventDates()).toEqual([D("2026-09-03"), D("2026-09-04")]);
  });
});

describe("seal safety (from the PR #9 review)", () => {
  it("leaves the grace day open so a stale-timestamped append still lands", async () => {
    // The failure this prevents: runIngest captures `ingestedAt` before hours of rate-limited fetching and
    // appends with it. Sealing yesterday at 00:05 would shut the day that append is still aiming at, and the
    // resulting root mismatch is unrepairable. One grace day means a two-day-stale timestamp still lands.
    const { ledger, scheduler } = rig(utc("2026-09-07T00:05:00Z"));
    ledger.append("ingest.started", { n: 1 }, utc("2026-09-06T23:00:00Z"));

    await scheduler.tick(utc("2026-09-07T00:05:00Z"));

    // Yesterday was not sealed, so the late append is still possible.
    expect(ledger.seal(D("2026-09-06"))).toBeUndefined();
    expect(() => ledger.append("ingest.completed", { n: 1 }, utc("2026-09-06T23:00:00Z"))).not.toThrow();
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("refuses, rather than corrupts, if an append does reach a sealed day", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-07T00:05:00Z"));
    ledger.append("ingest.started", { n: 1 }, utc("2026-09-04T23:00:00Z"));

    await scheduler.tick(utc("2026-09-07T00:05:00Z"));
    expect(ledger.seal(D("2026-09-04"))).toBeDefined();

    // Past the grace window the day is shut. The write fails loudly and the seal stays valid; the
    // alternative is a root that never matches again, with no repair path.
    expect(() => ledger.append("ingest.completed", { n: 1 }, utc("2026-09-04T23:00:00Z"))).toThrow(SealedDateAppendError);
    expect(ledger.verifySeals().ok).toBe(true);
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("computes the seal cutoff as yesterday less the grace window", () => {
    expect(sealThroughDate(utc("2026-09-07T00:05:00Z"))).toBe(D("2026-09-05"));
    expect(sealThroughDate(utc("2026-09-07T23:59:59Z"))).toBe(D("2026-09-05"));
    expect(sealThroughDate(utc("2026-01-01T00:05:00Z"))).toBe(D("2025-12-30"));
    expect(SEAL_GRACE_DAYS).toBe(1);
  });

  it("reports an unsealed backlog in health without failing the healthcheck", () => {
    // Visibility, not a restart. A day that cannot be sealed would otherwise restart the container forever,
    // which is worse than a backlog nobody can see. The check is informational and the status page shows it.
    const { ledger, db } = rig(utc("2026-09-07T00:05:00Z"));
    ledger.append("test.event", { n: 1 }, utc("2026-09-02T12:00:00Z"));

    const report = runHealth(
      { dataDir: dirname(db.path), mode: "RESEARCH", httpPort: 8479 } as unknown as Parameters<typeof runHealth>[0],
      db,
      new NyseCalendar(),
      utc("2026-09-07T00:05:00Z"),
    );
    const check = report.checks.find((c) => c.component === "ledger_seal_backlog");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("2026-09-02");
    expect(report.unsealedDays).toEqual([D("2026-09-02")]);
    // The backlog alone must not take the app down.
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });
});
