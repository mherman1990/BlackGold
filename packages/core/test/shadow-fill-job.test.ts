import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { addMs, Dec, isoDate, sha256Hex, type Db, type UtcInstant } from "@blackgold/shared";
import { Ledger, NyseCalendar, Scheduler, openCoreDb } from "../src/index.ts";
import { parseAppConfig } from "../src/config/load.ts";
import type { AppConfig } from "../src/config/schema.ts";
import { registerShadowDecisionJob } from "../src/decision/shadow-job.ts";
import { registerShadowFillJob, SHADOW_FILLS_RECORDED, SHADOW_INCIDENT, SHADOW_RECONCILED } from "../src/decision/shadow-fill-job.ts";
import { shadowFillRecords, type ShadowFillRecord } from "../src/decision/shadow-fills.ts";
import { fillDueSession, reconcileShadow } from "../src/decision/shadow-reconcile.ts";
import { loadCharterFile } from "../src/strategy/charter.ts";
import { buildMarket, D, N, type PricePath } from "./strategy-fixture.ts";

const cal = new NyseCalendar();
const afterClose = (session: string, mins: number): UtcInstant => addMs(cal.sessionClose(isoDate(session)), mins * 60_000);

// Fixture helpers mirror shadow-job.test.ts: the fill job composes with the decision job, so the environment
// must be the one that seals real records (same shrunk charter, policies, experiment registration, market).
function writeShadowCharter(dir: string): string {
  const src = fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url));
  const doc = parse(readFileSync(src, "utf8")) as Record<string, unknown>;
  const universe = doc["universe"] as Record<string, unknown>;
  universe["risk_etfs"] = ["VTI", "QQQ", "IWM", "VTV", "VUG", "XLK", "XLV", "XLU"];
  universe["conditional"] = [];
  universe["look_through_flagged"] = [];
  (doc["sizing"] as Record<string, unknown>)["clusters"] = [];
  const features = doc["features"] as Record<string, unknown>;
  Object.assign(features, { momentum_lookback_sessions: 20, momentum_skip_sessions: 4, trend_sma_sessions: 10, volatility_sessions: 15, adv_sessions: 5, min_adv_usd: "1000000" });
  const factors = doc["factors"] as { assignments: Record<string, unknown> };
  const keep = new Set([...(universe["risk_etfs"] as string[]), universe["cash_etf"] as string]);
  factors.assignments = Object.fromEntries(Object.entries(factors.assignments).filter(([sym]) => keep.has(sym)));
  const grid = doc["sensitivity_grid"] as Record<string, unknown>;
  grid["momentum"] = [{ lookback_sessions: 20, skip_sessions: 4 }, { lookback_sessions: 40, skip_sessions: 4 }];
  grid["trend_sma_sessions"] = [10, 15];
  grid["volatility_sessions"] = [15];
  const path = join(dir, "charter.yaml");
  writeFileSync(path, stringify(doc));
  return path;
}

const APPROVAL = { approvedBy: "Test Owner", approvedAt: "2026-03-01T00:00:00Z" };

function writePolicyDir(dir: string, opts: { approveRestrictedList?: boolean } = {}): void {
  writeFileSync(
    join(dir, "risk.yaml"),
    stringify({
      ...APPROVAL,
      positionLimits: { maxSingleEtfWeightPct: "1.00", maxOpenPositions: 50 },
      concentration: { maxSectorWeightPct: "1.00", maxThemeWeightPct: "1.00", maxFactorWeightPct: "1.00", maxCorrelatedClusterWeightPct: "1.00" },
      exposure: { minCashPct: "0.00" },
    }),
  );
  writeFileSync(
    join(dir, "restricted-list.yaml"),
    stringify({ ...(opts.approveRestrictedList === false ? {} : APPROVAL), asOf: "2026-03-01", themes: ["soybean_processing"] }),
  );
  writeFileSync(
    join(dir, "theme-membership.yaml"),
    stringify({ ...APPROVAL, asOf: "2026-03-01", maxAggregateThemeWeightPct: "0.10", maxHoldingsAgeDays: 7, issuers: [{ symbols: ["PROC"], themes: ["soybean_processing"] }] }),
  );
}

function registerExperimentFor(db: Db, charterHash: string): void {
  db.prepare(
    "INSERT INTO experiments (experiment_id, registered_at, registered_by, definition_json, definition_hash, labels_json) VALUES (?,?,?,?,?,?)",
  ).run(`exp-${sha256Hex(charterHash).slice(0, 8)}`, "2026-03-01T00:00:00Z", "test", JSON.stringify({ charter: { strategy_id: "etf-trend-vol", charter_version: "0.2.0", charter_hash: charterHash } }), `sha256:${sha256Hex(charterHash)}`, "[]");
}

const PATHS: PricePath[] = [
  { entityId: "VTI", start: N("200"), perSession: N("1.0010"), volumeShares: 4_000_000n, wobble: N("0.003") },
  { entityId: "QQQ", start: N("400"), perSession: N("1.0018"), volumeShares: 5_000_000n, wobble: N("0.005") },
  { entityId: "IWM", start: N("180"), perSession: N("1.0006"), volumeShares: 3_000_000n, wobble: N("0.004") },
  { entityId: "VTV", start: N("150"), perSession: N("1.0004"), volumeShares: 2_000_000n, wobble: N("0.002") },
  { entityId: "VUG", start: N("300"), perSession: N("1.0014"), volumeShares: 3_500_000n, wobble: N("0.004") },
  { entityId: "XLK", start: N("200"), perSession: N("1.0016"), volumeShares: 4_500_000n, wobble: N("0.005") },
  { entityId: "XLV", start: N("140"), perSession: N("1.0008"), volumeShares: 2_500_000n, wobble: N("0.003") },
  { entityId: "XLU", start: N("70"), perSession: N("0.9994"), volumeShares: 2_000_000n, wobble: N("0.002") },
  { entityId: "BIL", start: N("91"), perSession: N("1.00008"), volumeShares: 900_000n },
  { entityId: "SPY", start: N("500"), perSession: N("1.0010"), volumeShares: 6_000_000n, wobble: N("0.003") },
];

type Env = { db: Db; scheduler: Scheduler; config: AppConfig; charterPath: string; policyDir: string };

function setup(mode: "SHADOW" | "RESEARCH", withCharterPath = true, opts: { approveRestrictedList?: boolean } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "bg-shadowfill-"));
  const db = openCoreDb({ dbPath: join(dir, "s.sqlite") }).db;
  buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-03-20"), db });
  const charterPath = writeShadowCharter(dir);
  registerExperimentFor(db, loadCharterFile(charterPath).charterHash);
  writePolicyDir(dir, opts);
  const config = parseAppConfig({ mode, shadow: { ...(withCharterPath ? { charterPath } : {}), policyDir: dir } });
  const scheduler = new Scheduler({ db, ledger: new Ledger(db), calendar: cal, dueLookbackMs: 4 * 3_600_000, missedLookbackMs: 48 * 3_600_000 });
  registerShadowDecisionJob(scheduler, { config, calendar: cal });
  registerShadowFillJob(scheduler, { config, calendar: cal });
  return { db, scheduler, config, charterPath, policyDir: dir };
}

const events = (db: Db, kind: string): Record<string, unknown>[] =>
  (db.prepare("SELECT payload FROM ledger_events WHERE kind = ?").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

const fillRecordsOf = (db: Db): ShadowFillRecord[] => shadowFillRecords(db, "etf-trend-vol", "0.2.0");

describe("registerShadowFillJob gating", () => {
  it("registers only when a shadow charter is configured AND the mode seals prospective decisions", () => {
    const ids = (env: Env): string[] => env.scheduler.registeredJobs().map((j) => j.jobId);
    expect(ids(setup("SHADOW"))).toContain("shadow_fill");
    expect(ids(setup("RESEARCH"))).not.toContain("shadow_fill");
    expect(ids(setup("SHADOW", false))).not.toContain("shadow_fill");
  });
});

describe("shadow_fill job", () => {
  // 2026-03-06 is a Friday (the weekly decision session); fills land at the NEXT open, Monday 2026-03-09.
  it("fills each sealed decision with the internal simulator at the next open, bound to the sealed record", async () => {
    const env = setup("SHADOW");
    await env.scheduler.tick(afterClose("2026-03-06", 150)); // seals both arms; fills not yet due
    expect(fillRecordsOf(env.db)).toHaveLength(0);
    await env.scheduler.tick(afterClose("2026-03-09", 150)); // Monday: the fill session has closed
    const records = fillRecordsOf(env.db);
    expect(records.map((r) => r.arm).sort()).toEqual(["B0_PASSIVE", "B1_DETERMINISTIC"]);

    const b0 = records.find((r) => r.arm === "B0_PASSIVE");
    if (!b0) throw new Error("no B0 record");
    // The passive arm buys the benchmark from an all-cash synthetic book: one entry, filled on Monday.
    expect(b0.navAtDecision).toBe("100000");
    expect(b0.fills.length).toBeGreaterThan(0);
    for (const f of b0.fills) {
      expect(f.entityId).toBe("VTI"); // the charter's primary benchmark
      expect(f.side).toBe("BUY");
      expect(f.session).toBe("2026-03-09"); // never the decision session: delay_bars = 1
    }
    // The outcome is bound to the exact sealed decision content it fills.
    const sealedHash = (env.db.prepare("SELECT record_hash FROM decision_records WHERE arm = 'B0_PASSIVE'").get() as { record_hash: string }).record_hash;
    expect(b0.decisionRecordHash).toBe(sealedHash);
    expect(b0.decisionSession).toBe("2026-03-06");

    const recordedEvents = events(env.db, SHADOW_FILLS_RECORDED);
    expect(recordedEvents).toHaveLength(1);
    const reconciled = events(env.db, SHADOW_RECONCILED);
    expect(reconciled.length).toBeGreaterThan(0);
    expect(reconciled.at(-1)?.["breaks"]).toEqual([]);
    expect(events(env.db, SHADOW_INCIDENT)).toHaveLength(0);
  });

  it("suppresses every INCREASE when the sealed gate blocked new risk, and says so on the record", async () => {
    // The restricted list is unapproved, so both arms sealed with newRiskAllowed false. From an all-cash book
    // every order is an entry: nothing may fill, and the suppressed entities are evidence, not silence.
    const env = setup("SHADOW", true, { approveRestrictedList: false });
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    await env.scheduler.tick(afterClose("2026-03-09", 150));
    const records = fillRecordsOf(env.db);
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.fills).toEqual([]);
      expect(r.suppressedEntries.length).toBeGreaterThan(0);
      expect(r.cashAtDecision).toBe("100000"); // nothing traded, nothing moved
    }
    const b0 = records.find((r) => r.arm === "B0_PASSIVE");
    expect(b0?.suppressedEntries).toEqual(["VTI"]);
  });

  it("carries the synthetic book across weeks by replaying the fill ledger: a held benchmark is not re-bought", async () => {
    const env = setup("SHADOW");
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    await env.scheduler.tick(afterClose("2026-03-09", 150)); // week-1 fills recorded
    await env.scheduler.tick(afterClose("2026-03-13", 150)); // Friday: week-2 decisions sealed
    await env.scheduler.tick(afterClose("2026-03-16", 150)); // Monday: week-2 fills recorded
    const b0 = fillRecordsOf(env.db).filter((r) => r.arm === "B0_PASSIVE");
    expect(b0).toHaveLength(2);
    const [week1, week2] = b0;
    if (!week1 || !week2) throw new Error("missing B0 records");
    // Week 2's book is the replayed outcome of week 1, not a fresh 100000-cash book: the benchmark is already
    // held, so the passive target is inside the rebalance band and nothing trades. Without the replay carry
    // the arm would re-buy its whole book every week.
    expect(week2.navAtDecision).not.toBe("100000");
    expect(new Dec(week2.cashAtDecision).lt(new Dec("100000"))).toBe(true);
    expect(week2.fills).toEqual([]);
  });

  it("records each outcome exactly once: a later run adds no duplicate and reconciles clean", async () => {
    const env = setup("SHADOW");
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    await env.scheduler.tick(afterClose("2026-03-09", 150));
    await env.scheduler.tick(afterClose("2026-03-10", 150)); // Tuesday: nothing new is due
    expect(fillRecordsOf(env.db)).toHaveLength(2);
    expect(events(env.db, SHADOW_FILLS_RECORDED)).toHaveLength(1); // only the run that recorded something
    const reconciled = events(env.db, SHADOW_RECONCILED);
    expect(reconciled.length).toBeGreaterThanOrEqual(2); // every run with sealed records reconciles
    expect(reconciled.at(-1)?.["breaks"]).toEqual([]);
  });
});

describe("reconcileShadow (pure)", () => {
  const sealed = (arm: string, session: string): { arm: string; decisionAt: UtcInstant; decisionSession: ReturnType<typeof isoDate> } => ({
    arm,
    decisionAt: afterClose(session, 60),
    decisionSession: isoDate(session),
  });
  const fillFor = (arm: string, session: string, unfilled: { entityId: string; side: "BUY" | "SELL"; remaining: string; reason: "CASH" | "LIQUIDITY" | "NO_BARS" }[] = []): ShadowFillRecord =>
    ({ arm, decisionAt: afterClose(session, 60), unfilled, fills: [] }) as unknown as ShadowFillRecord;
  const base = { calendar: cal, arms: ["B0_PASSIVE", "B1_DETERMINISTIC"], delayBars: 1, bookCash: new Map() };

  it("flags a weekly decision session an arm failed to seal, from the first sealed session onward", () => {
    const breaks = reconcileShadow({
      ...base,
      sealed: [sealed("B0_PASSIVE", "2026-03-06"), sealed("B1_DETERMINISTIC", "2026-03-06"), sealed("B0_PASSIVE", "2026-03-13")],
      fillRecords: [fillFor("B0_PASSIVE", "2026-03-06"), fillFor("B1_DETERMINISTIC", "2026-03-06"), fillFor("B0_PASSIVE", "2026-03-13")],
      throughSession: isoDate("2026-03-16"),
    });
    expect(breaks).toEqual(["MISSING_DECISION_RECORD:B1_DETERMINISTIC:2026-03-13"]);
  });

  it("flags a sealed decision whose fill-due session has passed with no recorded outcome - and not before it is due", () => {
    const sealedRecords = [sealed("B0_PASSIVE", "2026-03-06"), sealed("B1_DETERMINISTIC", "2026-03-06")];
    // On the decision session itself the fill (due Monday) is not yet owed.
    expect(reconcileShadow({ ...base, sealed: sealedRecords, fillRecords: [], throughSession: isoDate("2026-03-06") })).toEqual([]);
    // Once Monday has completed, both outcomes are owed.
    expect(reconcileShadow({ ...base, sealed: sealedRecords, fillRecords: [], throughSession: isoDate("2026-03-09") })).toEqual([
      `MISSING_FILL_RECORD:B0_PASSIVE:${afterClose("2026-03-06", 60)}`,
      `MISSING_FILL_RECORD:B1_DETERMINISTIC:${afterClose("2026-03-06", 60)}`,
    ]);
  });

  it("flags unfilled remainders and negative replayed cash", () => {
    const breaks = reconcileShadow({
      ...base,
      sealed: [sealed("B0_PASSIVE", "2026-03-06"), sealed("B1_DETERMINISTIC", "2026-03-06")],
      fillRecords: [
        fillFor("B0_PASSIVE", "2026-03-06", [{ entityId: "SPY", side: "BUY", remaining: "3", reason: "LIQUIDITY" }]),
        // A CASH remainder is the book's own whole-share arithmetic, not a break (the fixture spans the reason dimension).
        fillFor("B1_DETERMINISTIC", "2026-03-06", [{ entityId: "QQQ", side: "BUY", remaining: "1", reason: "CASH" }]),
      ],
      throughSession: isoDate("2026-03-06"),
      bookCash: new Map([["B1_DETERMINISTIC", [{ session: isoDate("2026-03-06"), cash: new Dec("-1") }]]]),
    });
    expect(breaks).toEqual([
      "NEGATIVE_CASH:B1_DETERMINISTIC:2026-03-06",
      `UNFILLED_REMAINDER:B0_PASSIVE:${afterClose("2026-03-06", 60)}:SPY`,
    ]);
  });

  it("fillDueSession counts exchange sessions, not calendar days", () => {
    expect(fillDueSession(cal, isoDate("2026-03-06"), 1)).toBe("2026-03-09"); // Friday -> Monday
    expect(fillDueSession(cal, isoDate("2026-03-06"), 0)).toBe("2026-03-06");
  });
});
