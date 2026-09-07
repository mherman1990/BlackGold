import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, utc, type Db } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { parseAppConfig, type AppConfig } from "../src/config/load.ts";
import { openCoreDb } from "../src/db/open.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { runHealth } from "../src/health/health.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { registerPhase0Jobs } from "../src/serve.ts";
import { buildStatusReport, daysBehind } from "../src/status/model.ts";
import { bytes, esc, renderStatusPage } from "../src/status/render.ts";

const NOW = utc("2026-09-08T14:00:00Z");
const calendar = new NyseCalendar();

function fixture(): { db: Db; config: AppConfig } {
  const dir = mkdtempSync(join(tmpdir(), "bg-status-"));
  const config = parseAppConfig({ dataDir: dir });
  const { db } = openCoreDb(config);
  return { db, config };
}

function page(db: Db, config: AppConfig, now = NOW): string {
  return renderStatusPage(buildStatusReport(db, runHealth(config, db, calendar, now)));
}

describe("status page", () => {
  it("renders on a fresh install and says plainly that no result exists", () => {
    // The state Matt actually sees first: empty store, nothing ingested, no experiment. A dashboard that
    // renders blanks or crashes here is worse than none, and one that implies results exist is dangerous.
    const { db, config } = fixture();
    const html = page(db, config);

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("Black Gold");
    expect(html).toContain("Live trading is absent from this build");
    expect(html).toContain("liveCapable=false");
    expect(html).toContain("no result exists");
    expect(html).toContain("No observations ingested");
    // The sealed holdout is a once-only resource; the page must never imply it has been spent.
    expect(html).toContain("sealed holdout has never been opened");
    db.close();
  });

  it("never exposes a dollar amount or an account reference", () => {
    // docs/THREAT_MODEL.md A3 and T-22: the household financial picture must not reach a surface that leaves
    // the device, and a page served to a phone over Tailscale is such a surface. Asserted rather than assumed
    // because this is the kind of thing a later, well-meaning "just show the balance" change would break.
    const { db, config } = fixture();
    const ledger = new Ledger(db);
    ledger.append("heartbeat", { version: "0.1.0" }, NOW);
    const html = page(db, config);

    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).not.toMatch(/\bUSD\b/);
    expect(html).not.toMatch(/blackgold_sleeve|accountRef|account_ref/i);
    expect(html).not.toMatch(/BLACKGOLD_\w*(KEY|SECRET|TOKEN)/i);
    db.close();
  });

  it("is inert: no script, no outbound request, no form", () => {
    // The core process makes no outbound request by design, and the listener accepts no mutating method.
    // The document must not be able to undo either.
    const { db, config } = fixture();
    const html = page(db, config);

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/on(click|load|error|mouseover)=/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<img|<iframe|@import|url\(/i);
    db.close();
  });

  it("escapes hostile text from the store rather than rendering it", () => {
    // Job errors reach the page from the store. Nothing untrusted writes there today, but an ingest error can
    // carry a remote server's response text, so the escaping has to hold now rather than when that lands.
    const { db, config } = fixture();
    const scheduler = new Scheduler({ db, ledger: new Ledger(db), calendar, dueLookbackMs: 3_600_000, missedLookbackMs: 3_600_000 });
    registerPhase0Jobs(scheduler);
    db.prepare(
      "INSERT INTO job_runs (idempotency_key, job_id, scheduled_for, status, error) VALUES ('k1','heartbeat','2026-09-08T00:00:00.000Z','failed',?)",
    ).run('<script>alert("xss")</script>');
    const html = page(db, config);

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    db.close();
  });

  it("shows job state, including a missed run, once jobs are registered", () => {
    const { db, config } = fixture();
    const scheduler = new Scheduler({ db, ledger: new Ledger(db), calendar, dueLookbackMs: 3_600_000, missedLookbackMs: 3_600_000 });
    registerPhase0Jobs(scheduler);
    db.prepare(
      "INSERT INTO job_runs (idempotency_key, job_id, scheduled_for, status, finished_at) VALUES ('a','heartbeat','2026-09-07T00:00:00.000Z','succeeded','2026-09-07T00:00:01.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO job_runs (idempotency_key, job_id, scheduled_for, status) VALUES ('b','seal_ledger','2026-09-06T00:05:00.000Z','missed')",
    ).run();

    const report = buildStatusReport(db, runHealth(config, db, calendar, NOW));
    const heartbeat = report.jobs.find((j) => j.jobId === "heartbeat");
    const seal = report.jobs.find((j) => j.jobId === "seal_ledger");
    expect(heartbeat?.lastStatus).toBe("succeeded");
    expect(seal?.missedCount).toBe(1);

    const html = renderStatusPage(report);
    expect(html).toContain("seal_ledger");
    expect(html).toContain("missed");
    // A missed run is history, not a backlog - the page has to say so or it reads as an outstanding failure.
    expect(html).toContain("recorded as");
    db.close();
  });

  it("groups data coverage by source prefix so one row per series cannot flood the page", () => {
    const { db, config } = fixture();
    const ins = db.prepare(
      `INSERT INTO observations (source_id, source_locator, entity_id, available_at, ingested_at, raw_content_hash,
        adapter_version, parser_version, value_json, quality_flags_json, value_hash)
       VALUES (?, 'loc', ?, ?, '2026-09-08T00:00:00.000Z', 'h', '1', '1', '{}', '[]', ?)`,
    );
    ins.run("fred.DGS10", "us.dgs10", "2026-09-01T00:00:00.000Z", "v1");
    ins.run("fred.CPIAUCSL", "us.cpi", "2026-09-02T00:00:00.000Z", "v2");
    ins.run("sec.submissions", "cik.12345", "2026-08-01T00:00:00.000Z", "v3");

    const report = buildStatusReport(db, runHealth(config, db, calendar, NOW));
    expect(report.data.observations).toBe(3);
    expect(report.data.sources.map((s) => s.sourceId)).toEqual(["fred.", "sec."]);
    expect(report.data.sources.find((s) => s.sourceId === "fred.")?.observations).toBe(2);

    const html = renderStatusPage(report);
    // Stale sources must be visible: the point-in-time discipline means old data silently produces no
    // decisions rather than failing loudly.
    expect(html).toContain("stale");
    expect(html).not.toContain("No observations ingested");
    db.close();
  });

  it("surfaces a broken chain and unsealed days instead of a bare DEGRADED", () => {
    const { db, config } = fixture();
    const ledger = new Ledger(db);
    for (let i = 0; i < 3; i++) ledger.append("test", { i }, utc("2026-09-01T00:00:00Z"));
    db.exec("DROP TRIGGER ledger_events_no_update");
    db.exec("UPDATE ledger_events SET payload = '{\"i\":99}' WHERE seq = 2");

    const html = page(db, config);
    expect(html).toContain("DEGRADED");
    expect(html).toContain("broken at 2");
    // The unsealed day is the operator's cue that sealing is behind, not just that something is wrong.
    expect(html).toContain("2026-09-01");
    db.close();
  });

  it("reports the sealed holdout as spent once it is opened", () => {
    // The inverse of the fresh-install case. If the page said "sealed" after an open, it would misrepresent
    // the one thing the experiment protocol treats as irreversible.
    const { db, config } = fixture();
    db.prepare(
      `INSERT INTO experiments (experiment_id, registered_at, registered_by, definition_json, definition_hash,
         holdout_opened_at, labels_json)
       VALUES ('e1', '2026-09-01T00:00:00.000Z', 'matt', '{}', 'h', '2026-09-05T00:00:00.000Z', '[]')`,
    ).run();
    const report = buildStatusReport(db, runHealth(config, db, calendar, NOW));
    expect(report.evidence.holdoutsOpened).toBe(1);

    const html = renderStatusPage(report);
    expect(html).not.toContain("sealed holdout has never been opened");
    expect(html).toContain("Holdouts opened");
    expect(html).toContain("multiple-testing denominator");
    db.close();
  });
});

describe("status page helpers", () => {
  it("escapes every HTML-significant character", () => {
    expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("formats bytes in binary units", () => {
    expect(bytes(512)).toContain("512 B");
    expect(bytes(1024)).toContain("1.0 KiB");
    expect(bytes(5 * 1024 * 1024 * 1024)).toContain("5.0 GiB");
  });

  it("floors negative ages at zero rather than reporting the future", () => {
    // Clock skew between the Pi and a data source should not render "-2d".
    expect(daysBehind(NOW, isoDate("2026-09-01"))).toBe(7);
    expect(daysBehind(NOW, isoDate("2026-12-01"))).toBe(0);
    expect(daysBehind(NOW, undefined)).toBeUndefined();
  });
});
