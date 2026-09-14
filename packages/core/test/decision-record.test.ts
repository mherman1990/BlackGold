import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utc, type Db, type Mode } from "@blackgold/shared";
import { openCoreDb } from "../src/index.ts";
import {
  appendDecisionRecord,
  assertSealsProspectiveDecisions,
  decisionRecordCount,
  DecisionAlreadySealedError,
  DecisionModeError,
  DecisionRecordRedactionError,
  latestDecisionAt,
  sealDecision,
  sealsProspectiveDecisions,
  type ProspectiveDecisionRecord,
} from "../src/decision/decision-record.ts";

function record(overrides: Partial<ProspectiveDecisionRecord> = {}): ProspectiveDecisionRecord {
  return {
    recordVersion: 1,
    strategyId: "etf-trend-vol",
    strategyVersion: "0.2.0",
    charterHash: "sha256:" + "a".repeat(64),
    arm: "B1_DETERMINISTIC",
    mode: "SHADOW",
    decisionAt: utc("2026-09-11T20:00:00Z"),
    sealedAt: utc("2026-09-11T21:30:00Z"),
    snapshotIds: ["snap_prices_1"],
    // Already in canonical (entityId-sorted) order, as the producer must seal them.
    targetWeights: [
      { entityId: "QQQ", weight: "0.18" },
      { entityId: "SPY", weight: "0.20" },
    ],
    cashWeight: "0.62",
    gate: { newRiskAllowed: true, haltState: "NORMAL", increasedRisk: ["QQQ", "SPY"], blockedBy: [] },
    constructionVersion: 1,
    notes: [],
    ...overrides,
  };
}

function newDb(): Db {
  return openCoreDb({ dbPath: join(mkdtempSync(join(tmpdir(), "bg-decision-")), "d.sqlite") }).db;
}

describe("sealsProspectiveDecisions mode guard", () => {
  it("admits SHADOW and PAPER, refuses RESEARCH and BACKTEST", () => {
    expect(sealsProspectiveDecisions("SHADOW")).toBe(true);
    expect(sealsProspectiveDecisions("PAPER")).toBe(true);
    expect(sealsProspectiveDecisions("RESEARCH")).toBe(false);
    expect(sealsProspectiveDecisions("BACKTEST")).toBe(false);
    expect(() => {
      assertSealsProspectiveDecisions("BACKTEST");
    }).toThrow(DecisionModeError);
    expect(() => {
      assertSealsProspectiveDecisions("RESEARCH");
    }).toThrow(DecisionModeError);
  });

  it("refuses to seal a record whose mode may not seal decisions", () => {
    expect(() => sealDecision(record({ mode: "BACKTEST" as Mode }))).toThrow(DecisionModeError);
  });
});

describe("sealDecision", () => {
  it("is deterministic: the same record hashes the same, a changed field changes the hash", () => {
    const a = sealDecision(record());
    const b = sealDecision(record());
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const c = sealDecision(record({ cashWeight: "0.63" }));
    expect(c.hash).not.toBe(a.hash);
  });

  it("rejects a household/sleeve currency total smuggled into a note", () => {
    expect(() => sealDecision(record({ notes: ["sleeve NAV was $1,234,567.89"] }))).toThrow(DecisionRecordRedactionError);
  });

  it("rejects a secret pattern anywhere in the record", () => {
    expect(() => sealDecision(record({ notes: ["debug key sk-abc123def"] }))).toThrow(DecisionRecordRedactionError);
  });
});

describe("appendDecisionRecord (append-only ledger)", () => {
  it("seals and persists a record and counts it", () => {
    const db = newDb();
    const { hash } = appendDecisionRecord(db, record());
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decisionRecordCount(db)).toBe(1);
  });

  it("is immutable per (strategy version, arm, instant): a second seal for the same instant is refused", () => {
    const db = newDb();
    appendDecisionRecord(db, record());
    expect(() => appendDecisionRecord(db, record())).toThrow(DecisionAlreadySealedError);
    // A different book for the SAME instant/arm cannot silently rewrite history either.
    expect(() => appendDecisionRecord(db, record({ cashWeight: "0.70" }))).toThrow(DecisionAlreadySealedError);
    expect(decisionRecordCount(db)).toBe(1);
  });

  it("allows a different arm at the same instant, and a later instant", () => {
    const db = newDb();
    appendDecisionRecord(db, record());
    appendDecisionRecord(db, record({ arm: "B0_PASSIVE" }));
    appendDecisionRecord(db, record({ decisionAt: utc("2026-09-18T20:00:00Z") }));
    expect(decisionRecordCount(db)).toBe(3);
    expect(latestDecisionAt(db, "etf-trend-vol", "0.2.0")).toBe(utc("2026-09-18T20:00:00Z"));
  });

  it("latestDecisionAt is undefined before anything is sealed", () => {
    expect(latestDecisionAt(newDb(), "etf-trend-vol", "0.2.0")).toBeUndefined();
  });

  it("the decision_records table is append-only: raw UPDATE and DELETE abort", () => {
    const db = newDb();
    appendDecisionRecord(db, record());
    expect(() => {
      db.prepare("UPDATE decision_records SET halt_state = 'HOLD_ONLY'").run();
    }).toThrow();
    expect(() => {
      db.prepare("DELETE FROM decision_records").run();
    }).toThrow();
    expect(decisionRecordCount(db)).toBe(1);
  });
});
