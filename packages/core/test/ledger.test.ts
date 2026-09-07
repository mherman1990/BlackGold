import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, utc } from "@blackgold/shared";
import { Ledger, SealMismatchError, openCoreDb } from "../src/index.ts";

function newDb() {
  const dir = mkdtempSync(join(tmpdir(), "bg-ledger-"));
  return openCoreDb({ dbPath: join(dir, "l.sqlite") }).db;
}

const AT = utc("2026-09-08T14:00:00Z");

describe("Ledger", () => {
  it("appends a hash chain and verifies it", () => {
    const db = newDb();
    const ledger = new Ledger(db, () => Date.parse(AT));
    const a = ledger.append("test.a", { n: 1 });
    const b = ledger.append("test.b", { n: 2 });
    expect(a.seq).toBe(1);
    expect(b.prevHash).toBe(a.hash);
    expect(ledger.verifyChain()).toEqual({ ok: true });
    expect(ledger.count()).toBe(2);
    db.close();
  });

  it("append-only triggers block UPDATE and DELETE on ledger_events and ledger_seals", () => {
    const db = newDb();
    const ledger = new Ledger(db);
    ledger.append("test", { x: 1 }, AT);
    expect(() => { db.exec("UPDATE ledger_events SET kind = 'tampered' WHERE seq = 1"); }).toThrow(/append-only/);
    expect(() => { db.exec("DELETE FROM ledger_events WHERE seq = 1"); }).toThrow(/append-only/);
    ledger.sealDaily(isoDate("2026-09-08"), AT);
    expect(() => { db.exec("DELETE FROM ledger_seals"); }).toThrow(/append-only/);
    db.close();
  });

  it("detects tampering even if an attacker drops the triggers", () => {
    const db = newDb();
    const ledger = new Ledger(db);
    for (let i = 0; i < 5; i++) ledger.append("test", { i }, AT);
    db.exec("DROP TRIGGER ledger_events_no_update");
    db.exec("UPDATE ledger_events SET payload = '{\"i\":99}' WHERE seq = 3");
    const verdict = ledger.verifyChain();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.brokenAt).toBe(3);
    db.close();
  });

  it("daily seal is idempotent and a changed day raises SealMismatchError", () => {
    const db = newDb();
    const ledger = new Ledger(db);
    const day = isoDate("2026-09-08");
    ledger.append("test", { i: 1 }, AT);
    const first = ledger.sealDaily(day, AT);
    const again = ledger.sealDaily(day, AT);
    expect(again.rootHash).toBe(first.rootHash);
    expect(ledger.verifySeals()).toEqual({ ok: true, mismatches: [] });
    // A later event on an already sealed day changes the day's root: sealing again must fail loudly.
    ledger.append("test", { i: 2 }, utc("2026-09-08T20:00:00Z"));
    expect(() => ledger.sealDaily(day, AT)).toThrow(SealMismatchError);
    expect(ledger.verifySeals().ok).toBe(false);
    db.close();
  });

  it("an empty day seals deterministically", () => {
    const db = newDb();
    const ledger = new Ledger(db);
    const seal = ledger.sealDaily(isoDate("2026-01-01"), AT);
    expect(seal.firstSeq).toBeNull();
    expect(seal.rootHash).toHaveLength(64);
    db.close();
  });
});
