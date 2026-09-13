import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { epochMs, isoDate, utc, type UtcInstant } from "@blackgold/shared";
import { Ledger, NyseCalendar, Scheduler, openCoreDb } from "../src/index.ts";
import { parseAppConfig } from "../src/config/load.ts";
import { nextIngestRange, registerPhase0Jobs } from "../src/serve.ts";

const HOUR = 3_600_000;
const cal = new NyseCalendar();
// 2026-03-04 (Wed), -05 (Thu), -06 (Fri) are consecutive NYSE sessions with no holiday between them.
const afterClose = (session: string, mins: number): UtcInstant => utc(epochMs(cal.sessionClose(isoDate(session))) + mins * 60_000);

function newScheduler(): Scheduler {
  const db = openCoreDb({ dbPath: join(mkdtempSync(join(tmpdir(), "bg-autoingest-")), "s.sqlite") }).db;
  return new Scheduler({ db, ledger: new Ledger(db), calendar: cal, dueLookbackMs: 2 * HOUR, missedLookbackMs: 48 * HOUR });
}
const jobIds = (s: Scheduler): string[] => s.registeredJobs().map((j) => j.jobId);

describe("nextIngestRange", () => {
  it("returns undefined when the store is empty (initial ingest is manual)", () => {
    expect(nextIngestRange(undefined, afterClose("2026-03-06", 90), cal)).toBeUndefined();
  });

  it("spans the sessions after the latest stored bar through the latest completed session", () => {
    expect(nextIngestRange(afterClose("2026-03-04", 60), afterClose("2026-03-06", 90), cal)).toEqual({ start: "2026-03-05", end: "2026-03-06" });
  });

  it("returns undefined when no session has closed since the latest stored bar (same day and over a weekend)", () => {
    expect(nextIngestRange(afterClose("2026-03-06", 60), afterClose("2026-03-06", 90), cal)).toBeUndefined();
    expect(nextIngestRange(afterClose("2026-03-06", 60), utc("2026-03-07T18:00:00Z"), cal)).toBeUndefined();
  });
});

describe("registerPhase0Jobs auto-ingest job", () => {
  const config = (sources: Record<string, unknown> = {}) => parseAppConfig({ dataDir: "./data", sources });

  it("registers the incremental ingest job only when a charter path is configured", () => {
    const on = newScheduler();
    registerPhase0Jobs(on, { config: config({ autoIngestCharterPath: "strategies/etf-trend-vol/charter.yaml" }), calendar: cal });
    expect(jobIds(on)).toContain("ingest_market_data");
  });

  it("leaves the ingest job idle when unconfigured or when no deps are given", () => {
    const unconfigured = newScheduler();
    registerPhase0Jobs(unconfigured, { config: config(), calendar: cal });
    expect(jobIds(unconfigured)).not.toContain("ingest_market_data");

    const noDeps = newScheduler();
    registerPhase0Jobs(noDeps);
    expect(jobIds(noDeps)).not.toContain("ingest_market_data");
  });
});
