import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utc, isoDate } from "@blackgold/shared";
import {
  Ledger,
  NyseCalendar,
  StubNotifier,
  NtfyNotifier,
  RedactionError,
  backupDatabase,
  backupFileName,
  loadAppConfig,
  openCoreDb,
  pruneBackups,
  redact,
  runHealth,
  verifyRestore,
} from "../src/index.ts";

const AT = utc("2026-09-08T14:00:00Z");

describe("backup and restore drill", () => {
  it("backs up online, verifies the copy, and the restore report shows an intact chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-bk-"));
    const { db } = openCoreDb({ dbPath: join(dir, "b.sqlite") });
    const ledger = new Ledger(db);
    ledger.append("test", { i: 1 }, AT);
    ledger.sealDaily(isoDate("2026-09-08"), AT);
    const result = backupDatabase(db, join(dir, "backups"), AT);
    expect(result.ok).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path.endsWith(backupFileName(AT))).toBe(true);
    const report = verifyRestore(result.path);
    expect(report.ok).toBe(true);
    expect(report.eventCount).toBe(1);
    expect(report.latestSeal?.date).toBe("2026-09-08");
    db.close();
  });

  it("pruneBackups keeps the newest daily and one per older week", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-prune-"));
    const days: string[] = [];
    for (let i = 0; i < 40; i++) {
      const d = new Date(Date.UTC(2026, 8, 30 - i, 3, 0, 0));
      days.push(backupFileName(utc(d)));
    }
    for (const f of days) writeFileSync(join(dir, f), "x");
    const { kept, deleted } = pruneBackups(dir, 7, 4);
    expect(kept.length).toBeGreaterThanOrEqual(7);
    expect(kept.length).toBeLessThanOrEqual(11);
    expect(kept.length + deleted.length).toBe(40);
    // The seven newest are always kept.
    for (const f of days.slice(0, 7)) expect(kept, f).toContain(f);
  });
});

describe("health", () => {
  it("reports ok with liveCapable false and records a health_checks row", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-health-"));
    const config = loadAppConfig({ BLACKGOLD_DATA_DIR: dir });
    const { db } = openCoreDb(config);
    const report = runHealth(config, db, new NyseCalendar(), AT);
    expect(report.ok).toBe(true);
    expect(report.liveCapable).toBe(false);
    expect(report.nextSession).toBe("2026-09-09");
    const rows = db.prepare("SELECT count(*) AS n FROM health_checks").get() as { n: number };
    expect(rows.n).toBeGreaterThan(0);
    db.close();
  });
});

describe("notifications", () => {
  it("redact rejects dollar totals, key prefixes, and tokens instead of sending them", () => {
    expect(() => redact("NAV is $12,345 today")).toThrow(RedactionError);
    expect(() => redact("key sk-ant-abc")).toThrow(RedactionError);
    expect(() => redact("refresh token expired")).toThrow(RedactionError);
    expect(redact("Drawdown 3.2% of sleeve NAV; HALT_NEW_RISK engaged")).toContain("HALT_NEW_RISK");
  });

  it("stub notifier records sends and writes a ledger event; ntfy validates but does not deliver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-notify-"));
    const { db } = openCoreDb({ dbPath: join(dir, "n.sqlite") });
    const ledger = new Ledger(db);
    const stub = new StubNotifier(ledger);
    await stub.send({ level: "info", title: "Heartbeat", body: "ok" });
    expect(stub.sent).toHaveLength(1);
    expect(ledger.events().map((e) => e.kind)).toEqual(["notify.sent"]);
    expect(() => stub.send({ level: "urgent", title: "x", body: "balance $1,000,000" })).toThrow(RedactionError);
    expect(stub.sent).toHaveLength(1);
    const ntfy = new NtfyNotifier("https://ntfy.example.invalid/blackgold");
    await expect(ntfy.send({ level: "info", title: "x", body: "y" })).rejects.toThrow(/Phase 5/);
    expect(() => new NtfyNotifier("not a url")).toThrow();
    db.close();
  });
});
