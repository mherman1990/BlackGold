import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, utc } from "@blackgold/shared";
import { Ledger, SealedDateAppendError, SealMismatchError, openCoreDb } from "../src/index.ts";

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
    // An append onto an already sealed day is now refused outright, so the corruption this test used to
    // demonstrate is unreachable through the API. Changing a sealed day still has to be caught, but the
    // realistic route is an edit made around the API, which the next test covers.
    expect(() => ledger.append("test", { i: 2 }, utc("2026-09-08T20:00:00Z"))).toThrow(SealedDateAppendError);
    expect(ledger.verifySeals()).toEqual({ ok: true, mismatches: [] });
    db.close();
  });

  it("refuses an append dated inside a sealed day, naming the day and the kind", () => {
    const db = newDb();
    const ledger = new Ledger(db);
    ledger.append("test", { i: 1 }, AT);
    ledger.sealDaily(isoDate("2026-09-08"), AT);

    // The realistic cause: a caller that captured a timestamp, did slow work, and appended with the stale
    // value. Allowing it would break the day's root permanently, with no repair path.
    expect(() => ledger.append("ingest.completed", { pages: 9 }, utc("2026-09-08T23:59:59Z"))).toThrow(SealedDateAppendError);
    expect(() => ledger.append("ingest.completed", { pages: 9 }, utc("2026-09-08T23:59:59Z"))).toThrow(/2026-09-08/);
    expect(() => ledger.append("ingest.completed", { pages: 9 }, utc("2026-09-08T23:59:59Z"))).toThrow(/ingest\.completed/);

    // An unsealed day is unaffected, and the refusal left no partial row behind.
    const before = ledger.count();
    ledger.append("test", { i: 2 }, utc("2026-09-09T10:00:00Z"));
    expect(ledger.count()).toBe(before + 1);
    expect(ledger.verifyChain().ok).toBe(true);
    expect(ledger.verifySeals()).toEqual({ ok: true, mismatches: [] });
    db.close();
  });

  it("still raises SealMismatchError when a sealed day is edited around the API", () => {
    const db = newDb();
    const ledger = new Ledger(db);
    const day = isoDate("2026-09-08");
    ledger.append("test", { i: 1 }, AT);
    ledger.sealDaily(day, AT);

    // The actual threat model: an attacker with database access, not a caller using append(). Inserting a
    // row directly bypasses the append guard and changes the set of event hashes on that day, which is what
    // the daily root is computed from. (Editing only a payload would leave the root intact and be caught by
    // verifyChain instead, which recomputes hashes from payloads - the two checks cover different edits.)
    db.exec(
      "INSERT INTO ledger_events (seq, at, kind, payload, prev_hash, hash) VALUES " +
        "(99, '2026-09-08T20:00:00.000Z', 'smuggled', '{}', '" +
        "0".repeat(64) +
        "', '" +
        "f".repeat(64) +
        "')",
    );
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
