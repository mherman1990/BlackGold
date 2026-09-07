import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { epochMs, isoDate, utc, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { Ledger, NyseCalendar, Scheduler, openCoreDb, registerPhase0Jobs } from "../src/index.ts";

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
    ledger.append("test.event", { n: 1 }, utc("2026-09-04T12:00:00Z"));
    expect(ledger.seal(D("2026-09-04"))).toBeUndefined();

    await scheduler.tick(utc("2026-09-05T00:05:00Z"));

    const seal = ledger.seal(D("2026-09-04"));
    expect(seal).toBeDefined();
    expect(seal?.rootHash).toBe(ledger.computeDailyRoot(D("2026-09-04")).rootHash);
  });

  it("never seals today, only days that are complete", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-05T00:05:00Z"));
    ledger.append("test.event", { n: 1 }, utc("2026-09-04T12:00:00Z"));
    ledger.append("test.event", { n: 2 }, utc("2026-09-05T00:00:30Z"));

    await scheduler.tick(utc("2026-09-05T00:05:00Z"));

    expect(ledger.seal(D("2026-09-04"))).toBeDefined();
    // Today is still open; sealing it would freeze a root that later events would contradict.
    expect(ledger.seal(D("2026-09-05"))).toBeUndefined();
  });

  it("catches up the whole backlog after the appliance was powered off", async () => {
    // Events across four days, nothing sealed: the Pi was off and every run was recorded missed.
    const { ledger, scheduler } = rig(utc("2026-09-07T00:05:00Z"));
    for (const day of ["2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"]) {
      ledger.append("test.event", { day }, utc(`${day}T12:00:00Z`));
    }
    expect(ledger.seals()).toHaveLength(0);

    await scheduler.tick(utc("2026-09-07T00:05:00Z"));

    // One successful run repairs the entire gap.
    const sealedDates = ledger.seals().map((s) => s.date);
    expect(sealedDates).toEqual([D("2026-09-03"), D("2026-09-04"), D("2026-09-05"), D("2026-09-06")]);
    for (const d of sealedDates) {
      expect(ledger.seal(d)?.rootHash).toBe(ledger.computeDailyRoot(d).rootHash);
    }
    expect(ledger.verifySeals().ok).toBe(true);
  });

  it("skips days that have no events, because an empty day has nothing to protect", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-07T00:05:00Z"));
    ledger.append("test.event", { n: 1 }, utc("2026-09-03T12:00:00Z"));
    ledger.append("test.event", { n: 2 }, utc("2026-09-06T12:00:00Z"));

    await scheduler.tick(utc("2026-09-07T00:05:00Z"));

    expect(ledger.seals().map((s) => s.date)).toEqual([D("2026-09-03"), D("2026-09-06")]);
  });

  it("records what it sealed in the ledger itself", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-05T00:05:00Z"));
    ledger.append("test.event", { n: 1 }, utc("2026-09-04T12:00:00Z"));

    await scheduler.tick(utc("2026-09-05T00:05:00Z"));

    const sealEvents = ledger.events().filter((e) => e.kind === "ledger.sealed");
    expect(sealEvents).toHaveLength(1);
    const payload = sealEvents[0]?.payload as { dates: string[]; throughDate: string };
    expect(payload.dates).toEqual(["2026-09-04"]);
    expect(payload.throughDate).toBe("2026-09-04");
  });

  it("writes no seal event when there was nothing to seal", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-05T00:05:00Z"));
    await scheduler.tick(utc("2026-09-05T00:05:00Z"));
    expect(ledger.events().filter((e) => e.kind === "ledger.sealed")).toHaveLength(0);
  });

  it("does nothing on a second run at the same instant", async () => {
    const { ledger, scheduler } = rig(utc("2026-09-05T00:05:00Z"));
    ledger.append("test.event", { n: 1 }, utc("2026-09-04T12:00:00Z"));

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
    const first = rig(utc("2026-09-05T00:05:00Z"), path);
    first.ledger.append("test.event", { n: 1 }, utc("2026-09-04T12:00:00Z"));
    await first.scheduler.tick(utc("2026-09-05T00:05:00Z"));
    expect(first.ledger.seals().map((s) => s.date)).toEqual([D("2026-09-04")]);
    // The run left an event on 09-05, so 09-05 is now an unsealed day.
    expect(first.ledger.unsealedDates(D("2026-09-05"))).toEqual([D("2026-09-05")]);
    first.db.close();

    const second = rig(utc("2026-09-06T00:05:00Z"), path);
    await second.scheduler.tick(utc("2026-09-06T00:05:00Z"));
    expect(second.ledger.seals().map((s) => s.date)).toEqual([D("2026-09-04"), D("2026-09-05")]);
    expect(second.ledger.verifySeals().ok).toBe(true);
    // Nothing before today is left unsealed.
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
    ledger.sealDaily(D("2026-09-03"), utc("2026-09-04T00:05:00Z"));

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
