import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dec,
  sumDec,
  roundTo,
  decToString,
  utc,
  isoDate,
  durationMs,
  zonedToUtc,
  dateOfInstantInZone,
  addDays,
  weekday,
  sha256Hex,
  canonicalJson,
  deterministicId,
  computeEventHash,
  verifyEventChain,
  GENESIS_HASH,
  openDatabase,
  migrate,
  integrityCheck,
  backupTo,
  type LedgerEvent,
} from "../src/index.ts";

describe("money", () => {
  it("rejects non-integer number inputs to prevent float contamination", () => {
    expect(() => dec(0.1)).toThrow(TypeError);
    expect(dec("0.1").plus(dec("0.2")).toString()).toBe("0.3");
  });
  it("sums and rounds with banker's rounding", () => {
    expect(decToString(sumDec([dec("1.005"), dec("2.005")]))).toBe("3.01");
    expect(decToString(roundTo(dec("2.5"), 0))).toBe("2");
    expect(decToString(roundTo(dec("3.5"), 0))).toBe("4");
  });
});

describe("time", () => {
  it("normalizes instants and rejects non-UTC strings", () => {
    expect(utc("2026-09-06T14:00:00Z")).toBe("2026-09-06T14:00:00.000Z");
    expect(() => utc("2026-09-06T14:00:00-05:00")).toThrow();
    expect(() => isoDate("2026-13-01")).toThrow();
  });
  it("parses the durations we use", () => {
    expect(durationMs("PT90M")).toBe(90 * 60_000);
    expect(durationMs("P1DT2H")).toBe(26 * 3_600_000);
  });
  it("does calendar arithmetic", () => {
    expect(addDays(isoDate("2026-12-31"), 1)).toBe("2027-01-01");
    expect(weekday(isoDate("2026-09-06"))).toBe(0);
  });
  it("converts New York wall-clock to UTC across DST", () => {
    expect(zonedToUtc(isoDate("2026-07-01"), 16, 0, "America/New_York")).toBe("2026-07-01T20:00:00.000Z");
    expect(zonedToUtc(isoDate("2026-01-15"), 16, 0, "America/New_York")).toBe("2026-01-15T21:00:00.000Z");
    expect(zonedToUtc(isoDate("2026-03-08"), 9, 30, "America/New_York")).toBe("2026-03-08T13:30:00.000Z");
    expect(zonedToUtc(isoDate("2026-11-01"), 16, 0, "America/New_York")).toBe("2026-11-01T21:00:00.000Z");
    expect(dateOfInstantInZone(utc("2026-03-09T03:00:00Z"), "America/New_York")).toBe("2026-03-08");
  });
});

describe("hash and ids", () => {
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("deterministic ids are pure functions of their inputs", () => {
    expect(deterministicId("ord", "a", 1)).toBe(deterministicId("ord", "a", 1));
    expect(deterministicId("ord", "a", 1)).not.toBe(deterministicId("ord", "a", 2));
  });
});

describe("event chain", () => {
  function chain(n: number): LedgerEvent[] {
    const out: LedgerEvent[] = [];
    let prev = GENESIS_HASH;
    for (let seq = 1; seq <= n; seq++) {
      const base = { seq, at: utc("2026-09-06T00:00:00Z"), kind: "test", payload: { seq }, prevHash: prev };
      const hash = computeEventHash(base);
      out.push({ ...base, hash });
      prev = hash;
    }
    return out;
  }
  it("verifies a valid chain and detects any mutation", () => {
    const events = chain(5);
    expect(verifyEventChain(events)).toEqual({ ok: true });
    const tampered = structuredClone(events);
    (tampered[2] as { payload: unknown }).payload = { seq: 99 };
    expect(verifyEventChain(tampered)).toMatchObject({ ok: false, brokenAt: 3 });
  });
});

describe("db", () => {
  it("applies migrations once, refuses modified migrations, backs up, and passes integrity", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-"));
    const db = openDatabase(join(dir, "t.sqlite"));
    const m = [{ id: "001", up: "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);" }];
    expect(migrate(db, m).applied).toEqual(["001"]);
    expect(migrate(db, m).applied).toEqual([]);
    expect(() => migrate(db, [{ id: "001", up: "CREATE TABLE t2 (id INTEGER);" }])).toThrow(/modified/);
    db.prepare("INSERT INTO t (v) VALUES (?)").run("x");
    expect(integrityCheck(db).ok).toBe(true);
    const dest = join(dir, "backup", "t.sqlite");
    backupTo(db, dest);
    expect(existsSync(dest)).toBe(true);
    const restored = openDatabase(dest, { readOnly: true });
    expect((restored.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(1);
    restored.close();
    db.close();
  });
  it("journal mode is WAL", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-"));
    const db = openDatabase(join(dir, "w.sqlite"));
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    db.close();
  });
});
