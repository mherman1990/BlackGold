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
import { runFullVerification, readLastFullVerification } from "../src/health/integrity.ts";

const NOW = utc("2026-09-08T14:00:00Z");
const calendar = new NyseCalendar();

function fixture(): { db: Db; config: AppConfig; ledger: Ledger } {
  const dir = mkdtempSync(join(tmpdir(), "bg-integrity-"));
  const config = parseAppConfig({ dataDir: dir });
  const { db } = openCoreDb(config);
  return { db, config, ledger: new Ledger(db) };
}

describe("runFullVerification", () => {
  it("records a clear result on a sound ledger and reads it back", () => {
    const { db, ledger } = fixture();
    ledger.append("a", { n: 1 }, utc("2026-09-06T12:00:00Z"));
    ledger.sealDaily(isoDate("2026-09-06"), NOW);

    const result = runFullVerification(db, ledger, NOW);
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ integrityOk: true, chainOk: true, sealsOk: true, at: NOW });

    const readBack = readLastFullVerification(db);
    expect(readBack).toEqual(result);
    // Also written to the health_checks history for the same reason every other check is.
    const row = db.prepare("SELECT ok FROM health_checks WHERE component = 'full_verification' ORDER BY at DESC LIMIT 1").get() as { ok: number };
    expect(row.ok).toBe(1);
    db.close();
  });

  it("records a failure, with the break named, when the chain is tampered", () => {
    const { db, ledger } = fixture();
    for (let i = 1; i <= 3; i++) ledger.append("e", { i }, NOW);
    db.exec("DROP TRIGGER ledger_events_no_update");
    db.exec("UPDATE ledger_events SET payload = '{\"i\":99}' WHERE seq = 2");

    const result = runFullVerification(db, ledger, NOW);
    expect(result.ok).toBe(false);
    expect(result.chainOk).toBe(false);
    expect(result.detail).toContain("chain broken at seq 2");
    expect(readLastFullVerification(db)?.ok).toBe(false);
    db.close();
  });

  it("returns null before any verification has run", () => {
    const { db } = fixture();
    expect(readLastFullVerification(db)).toBeNull();
    db.close();
  });
});

describe("runHealth integration with full verification", () => {
  it("reports 'pending' and stays non-fatal before the first full verification", () => {
    const { db, config } = fixture();
    const report = runHealth(config, db, calendar, NOW);
    expect(report.lastFullVerification).toBeNull();
    const full = report.checks.find((c) => c.component === "full_verification");
    expect(full?.ok).toBe(true);
    expect(full?.detail).toContain("no full verification recorded yet");
    db.close();
  });

  it("surfaces a recorded full-verification failure as a fatal health check", () => {
    const { db, config, ledger } = fixture();
    for (let i = 1; i <= 3; i++) ledger.append("e", { i }, NOW);
    db.exec("DROP TRIGGER ledger_events_no_update");
    db.exec("UPDATE ledger_events SET payload = '{\"i\":99}' WHERE seq = 2");
    runFullVerification(db, ledger, NOW);

    const report = runHealth(config, db, calendar, NOW);
    const full = report.checks.find((c) => c.component === "full_verification");
    expect(full?.ok).toBe(false);
    expect(report.ok).toBe(false);
    db.close();
  });

  it("does not rescan the sealed prefix on the hot path", () => {
    const { db, config, ledger } = fixture();
    ledger.append("a", { n: 1 }, utc("2026-09-06T12:00:00Z"));
    ledger.append("b", { n: 2 }, utc("2026-09-06T12:00:00Z"));
    ledger.sealDaily(isoDate("2026-09-06"), NOW);
    // Tamper a sealed event. A full rescan would catch it; the hot-path tail check must not, by design.
    db.exec("DROP TRIGGER ledger_events_no_update");
    db.exec("UPDATE ledger_events SET payload = '{\"n\":777}' WHERE seq = 1");

    const report = runHealth(config, db, calendar, NOW);
    expect(report.ledgerChain.ok).toBe(true);
    // The scheduled full verify is what catches it.
    expect(runFullVerification(db, ledger, NOW).ok).toBe(false);
    db.close();
  });
});
