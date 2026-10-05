import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { addMs, Dec, isoDate, sha256Hex, type Db, type UtcInstant } from "@blackgold/shared";
import { Ledger, NyseCalendar, PointInTimeRepository, Scheduler, corporateActionObservation, openCoreDb } from "../src/index.ts";
import { parseAppConfig } from "../src/config/load.ts";
import type { AppConfig } from "../src/config/schema.ts";
import { registerShadowDecisionJob, shadowStatusForNextDecision, upcomingShadowDecision } from "../src/decision/shadow-job.ts";
import { registerShadowFillJob, SHADOW_FILLS_RECORDED, SHADOW_INCIDENT, SHADOW_RECONCILED } from "../src/decision/shadow-fill-job.ts";
import { appendShadowFillRecord, shadowFillRecords, SHADOW_FILL_RECORD_VERSION, type ShadowFillRecord } from "../src/decision/shadow-fills.ts";
import { fillDueSession, fillOwedSession, fillWindowEndSession, reconcileShadow } from "../src/decision/shadow-reconcile.ts";
import { loadCharterFile } from "../src/strategy/charter.ts";
import { appendDecisionRecord, type ProspectiveDecisionRecord } from "../src/decision/decision-record.ts";
import { readShadowHaltInputs, recordShadowReArm, ShadowReArmError, SHADOW_HALT_REARM } from "../src/decision/shadow-halt.ts";
import { buildMarket, D, N, type PricePath } from "./strategy-fixture.ts";

const cal = new NyseCalendar();
const afterClose = (session: string, mins: number): UtcInstant => addMs(cal.sessionClose(isoDate(session)), mins * 60_000);

// Fixture helpers mirror shadow-job.test.ts: the fill job composes with the decision job, so the environment
// must be the one that seals real records (same shrunk charter, policies, experiment registration, market).
function writeShadowCharter(dir: string, decisionOffsetMinutes?: number): string {
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
  if (decisionOffsetMinutes !== undefined) (doc["rules"] as Record<string, unknown>)["decision_offset_minutes"] = decisionOffsetMinutes;
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

function setup(
  mode: "SHADOW" | "RESEARCH",
  withCharterPath = true,
  opts: {
    approveRestrictedList?: boolean;
    decisionOffsetMinutes?: number;
    vtiVolumeShares?: bigint;
    dividend?: { exDate: string; payDate: string; amount: string };
    omitSessions?: Record<string, string[]>;
    withFillJob?: boolean;
  } = {},
): Env {
  const dir = mkdtempSync(join(tmpdir(), "bg-shadowfill-"));
  const db = openCoreDb({ dbPath: join(dir, "s.sqlite") }).db;
  const vtiVolume = opts.vtiVolumeShares;
  const paths = vtiVolume === undefined ? PATHS : PATHS.map((pp) => (pp.entityId === "VTI" ? { ...pp, volumeShares: vtiVolume } : pp));
  const omitSessions = opts.omitSessions === undefined ? undefined : Object.fromEntries(Object.entries(opts.omitSessions).map(([k, v]) => [k, v.map((s) => D(s))]));
  buildMarket({ paths, from: D("2026-01-02"), to: D("2026-03-27"), db, ...(omitSessions === undefined ? {} : { omitSessions }) });
  if (opts.dividend !== undefined) {
    new PointInTimeRepository(db).append(
      corporateActionObservation(
        { kind: "CASH_DIVIDEND", entityId: "VTI", amount: new Dec(opts.dividend.amount), exDate: isoDate(opts.dividend.exDate), payDate: isoDate(opts.dividend.payDate), qualified: true },
        { sourceLocator: "test/div/VTI", availableAt: afterClose(opts.dividend.exDate, 60), ingestedAt: afterClose(opts.dividend.exDate, 60), rawContentHash: `sha256:${sha256Hex("div")}`, adapterVersion: "1.0.0", parserVersion: "1.0.0" },
      ),
    );
  }
  const charterPath = writeShadowCharter(dir, opts.decisionOffsetMinutes);
  registerExperimentFor(db, loadCharterFile(charterPath).charterHash);
  writePolicyDir(dir, opts);
  const config = parseAppConfig({ mode, shadow: { ...(withCharterPath ? { charterPath } : {}), policyDir: dir } });
  const scheduler = new Scheduler({ db, ledger: new Ledger(db), calendar: cal, dueLookbackMs: 4 * 3_600_000, missedLookbackMs: 48 * 3_600_000 });
  registerShadowDecisionJob(scheduler, { config, calendar: cal });
  if (opts.withFillJob !== false) registerShadowFillJob(scheduler, { config, calendar: cal });
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

describe("shadow_fill job: schedule, deferral, and dividend entitlement (Codex round 1)", () => {
  it("derives its schedule from the charter so reconciliation can never precede that session's sealing (Codex P2)", async () => {
    // A 300-minute decision offset: the decision job schedules at close+330. A fixed close+150 fill job would
    // reconcile BEFORE sealing on every decision Friday and raise a phantom MISSING_DECISION_RECORD incident.
    const env = setup("SHADOW", true, { decisionOffsetMinutes: 300 });
    const offsets = new Map(env.scheduler.registeredJobs().map((j) => [j.jobId, (j.schedule as { offsetMs: number }).offsetMs]));
    expect(offsets.get("shadow_fill")).toBe(330 * 60_000);
    expect(offsets.get("shadow_fill")).toBe(offsets.get("shadow_decision")); // same instant; jobId order runs decision first
    await env.scheduler.tick(afterClose("2026-03-06", 340));
    const reconciled = events(env.db, SHADOW_RECONCILED);
    expect(reconciled.at(-1)?.["breaks"]).toEqual([]); // the session's own records sealed in the same tick
    expect(events(env.db, SHADOW_INCIDENT)).toHaveLength(0);
  });

  it("defers finalizing a working LIQUIDITY remainder until the simulator's whole fill window has completed (Codex P1)", async () => {
    // VTI trades 12000 shares a session, so at 0.5% ADV participation the passive arm's ~470-share buy caps
    // at ~60 shares per bar: the first
    // fill session leaves a remainder that LATER bars inside the 5-bar window could still work. Sealing it on
    // Monday would freeze an outcome the simulator had not finished producing - immutably.
    const env = setup("SHADOW", true, { vtiVolumeShares: 12_000n });
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    await env.scheduler.tick(afterClose("2026-03-09", 150));
    const monday = fillRecordsOf(env.db);
    expect(monday.some((r) => r.arm === "B0_PASSIVE")).toBe(false); // deferred, not sealed short
    expect((events(env.db, SHADOW_RECONCILED).at(-1)?.["breaks"] as string[]).filter((b) => b.startsWith("MISSING_FILL_RECORD"))).toEqual([]); // not owed before the window ends
    await env.scheduler.tick(afterClose("2026-03-13", 150)); // the window's last bar (delay 1 + 5 bars) has completed
    const b0 = fillRecordsOf(env.db).find((r) => r.arm === "B0_PASSIVE" && r.decisionSession === "2026-03-06");
    if (!b0) throw new Error("B0 not finalized at the window end");
    expect(new Set(b0.fills.map((f) => f.session)).size).toBeGreaterThan(1); // the remainder was worked across bars
    expect(b0.unfilled.some((u) => u.reason === "LIQUIDITY")).toBe(true); // the genuine leftover, now final
    // And a genuine post-window liquidity remainder IS a reconciler break.
    expect((events(env.db, SHADOW_RECONCILED).at(-1)?.["breaks"] as string[]).some((b) => b.startsWith("UNFILLED_REMAINDER:B0_PASSIVE"))).toBe(true);
    expect(events(env.db, SHADOW_INCIDENT).length).toBeGreaterThan(0);
  });

  it("credits a dividend to the EX-DATE holding, not the pay-date one (Codex P1)", async () => {
    // Ex-date Friday 2026-03-06 (before the arm's first buy on Monday), pay date Wednesday: the book bought
    // between ex and pay and is NOT entitled. The pay-date default would credit ~470 shares x 10.
    const notEntitled = setup("SHADOW", true, { dividend: { exDate: "2026-03-06", payDate: "2026-03-11", amount: "10" } });
    await notEntitled.scheduler.tick(afterClose("2026-03-06", 150));
    await notEntitled.scheduler.tick(afterClose("2026-03-09", 150));
    await notEntitled.scheduler.tick(afterClose("2026-03-13", 150));
    await notEntitled.scheduler.tick(afterClose("2026-03-16", 150));
    const na = fillRecordsOf(notEntitled.db).find((r) => r.arm === "B0_PASSIVE" && r.decisionSession === "2026-03-13");
    if (!na) throw new Error("no week-2 B0 record");
    expect(new Dec(na.cashAtDecision).lt(new Dec("1500"))).toBe(true); // only the buy's leftover; no unearned credit

    // Control (the fixture spans the entitlement dimension): ex-date after the buy - the holding IS entitled.
    const entitled = setup("SHADOW", true, { dividend: { exDate: "2026-03-11", payDate: "2026-03-12", amount: "10" } });
    await entitled.scheduler.tick(afterClose("2026-03-06", 150));
    await entitled.scheduler.tick(afterClose("2026-03-09", 150));
    await entitled.scheduler.tick(afterClose("2026-03-13", 150));
    await entitled.scheduler.tick(afterClose("2026-03-16", 150));
    const ea = fillRecordsOf(entitled.db).find((r) => r.arm === "B0_PASSIVE" && r.decisionSession === "2026-03-13");
    if (!ea) throw new Error("no week-2 B0 record (entitled env)");
    expect(new Dec(ea.cashAtDecision).gt(new Dec("3000"))).toBe(true); // ~470 shares x 10 credited
  });
});

describe("shadow loop repairs (Codex, PR #102 round 3)", () => {
  type SealedEvent = { session: string; startingBook: { held: string[]; staleInputs: string[] } };
  const sealedEvents = (db: Db): SealedEvent[] => events(db, "shadow.decision_sealed") as unknown as SealedEvent[];

  it("seals each later decision against the REPLAYED B1 book, not an empty one (P1)", async () => {
    const env = setup("SHADOW");
    await env.scheduler.tick(afterClose("2026-03-06", 150)); // week 1: sealed from empty
    await env.scheduler.tick(afterClose("2026-03-09", 150)); // week-1 fills recorded
    await env.scheduler.tick(afterClose("2026-03-13", 150)); // week 2: sealed from the carried book
    const [week1, week2] = sealedEvents(env.db);
    if (!week1 || !week2) throw new Error("expected two sealed decision events");
    expect(week1.startingBook).toEqual({ held: [], staleInputs: [] });

    // What B1 actually bought in week 1, read straight from its fill record - an independent derivation of
    // the book the week-2 decision must start from.
    const b1Week1 = fillRecordsOf(env.db).find((r) => r.arm === "B1_DETERMINISTIC" && r.decisionSession === "2026-03-06");
    if (!b1Week1) throw new Error("no week-1 B1 fill record");
    const bought = [...new Set(b1Week1.fills.filter((f) => f.side === "BUY").map((f) => f.entityId))].sort();
    expect(bought.length).toBeGreaterThan(0);
    expect(week2.startingBook).toEqual({ held: bought, staleInputs: [] });

    // The gate reads the carried weights: a holding already at or above its new target is not new risk, so
    // week 2's increased-risk set is a strict subset of its positive targets (from empty it would be all of them).
    const rec = env.db.prepare("SELECT record_json FROM decision_records WHERE arm = 'B1_DETERMINISTIC' ORDER BY decision_at DESC LIMIT 1").get() as { record_json: string };
    const parsed = JSON.parse(rec.record_json) as { targetWeights: { entityId: string; weight: string }[]; gate: { increasedRisk: string[] } };
    const positive = parsed.targetWeights.filter((w) => new Dec(w.weight).gt(0)).map((w) => w.entityId);
    expect(parsed.gate.increasedRisk.length).toBeLessThan(positive.length);
  });

  it("blocks new risk when a prior B1 decision has no recorded outcome: the book is unknown (fail closed)", async () => {
    // No fill job: week 1 is sealed but never filled, so the week-2 decision cannot know its starting book.
    const env = setup("SHADOW", true, { withFillJob: false });
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    await env.scheduler.tick(afterClose("2026-03-13", 150));
    const week2 = sealedEvents(env.db).at(-1);
    expect(week2?.startingBook.staleInputs).toEqual([`shadow_book_incomplete:B1_DETERMINISTIC has no recorded outcome for ${afterClose("2026-03-06", 60)}`]);
    const rows = env.db.prepare("SELECT arm, new_risk_allowed, record_json FROM decision_records WHERE decision_at = ?").all(afterClose("2026-03-13", 60)) as { arm: string; new_risk_allowed: number; record_json: string }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.new_risk_allowed).toBe(0);
      expect(r.record_json).toContain("shadow_book_incomplete");
    }
  });

  it("ignores a fill record computed AFTER the decision instant: the starting book is knowledge-scoped", async () => {
    // Week 1 is sealed but its outcome only lands at 03-13 21:30Z - after the week-2 decision instant (close
    // 20:00Z + 60 min) but before the delayed run executes. The decision is timestamp-locked to an instant at
    // which that outcome did not exist, so the book is still unknown there.
    const env = setup("SHADOW", true, { withFillJob: false });
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    const week1 = env.db.prepare("SELECT decision_at, record_hash FROM decision_records WHERE arm = 'B1_DETERMINISTIC'").get() as { decision_at: UtcInstant; record_hash: string };
    appendShadowFillRecord(env.db, {
      recordVersion: SHADOW_FILL_RECORD_VERSION,
      strategyId: "etf-trend-vol",
      strategyVersion: "0.2.0",
      charterHash: loadCharterFile(env.charterPath).charterHash,
      arm: "B1_DETERMINISTIC",
      decisionAt: week1.decision_at,
      decisionSession: isoDate("2026-03-06"),
      decisionRecordHash: week1.record_hash,
      computedAt: afterClose("2026-03-13", 90),
      navAtDecision: "100000",
      cashAtDecision: "100000",
      fills: [],
      suppressedEntries: [],
      suppressedExits: [],
      unfilled: [],
      unpriced: [],
      executionShortfall: "0",
      labels: [],
    });
    await env.scheduler.tick(afterClose("2026-03-13", 150));
    expect(sealedEvents(env.db).at(-1)?.startingBook.staleInputs).toEqual([`shadow_book_incomplete:B1_DETERMINISTIC has no recorded outcome for ${week1.decision_at}`]);
  });

  it("defers finalizing past the calendar window when the entity is missing a bar inside it (P1)", async () => {
    // VTI is thin (a LIQUIDITY remainder) AND has no bar on Wednesday 03-11, inside B0's Mon-Fri window. The
    // simulator works VTI's OWN bars, so its fifth is Monday 03-16: finalizing on the calendar end (Friday
    // 03-13) would seal a remainder the simulator had one more bar to work.
    const env = setup("SHADOW", true, { vtiVolumeShares: 12_000n, omitSessions: { VTI: ["2026-03-11"] } });
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    await env.scheduler.tick(afterClose("2026-03-09", 150));
    await env.scheduler.tick(afterClose("2026-03-13", 150));
    const b0At = (): ShadowFillRecord | undefined => fillRecordsOf(env.db).find((r) => r.arm === "B0_PASSIVE" && r.decisionSession === "2026-03-06");
    expect(b0At()).toBeUndefined(); // the calendar window has ended, the entity's window has not
    expect((events(env.db, SHADOW_RECONCILED).at(-1)?.["breaks"] as string[]).filter((b) => b.startsWith("MISSING_FILL_RECORD"))).toEqual([]);
    await env.scheduler.tick(afterClose("2026-03-16", 150));
    const b0 = b0At();
    if (!b0) throw new Error("B0 not finalized once VTI's own bars covered the window");
    expect(b0.fills.some((f) => f.session === "2026-03-16")).toBe(true); // the fifth bar did work the remainder
    expect(b0.fills.some((f) => f.session === "2026-03-11")).toBe(false);
  });

  it("finalizes at the owed bound when the entity's bars stop arriving, instead of stalling the arm forever", async () => {
    // VTI is thin and its feed dies after Monday 03-09: the simulator's window is never observed. At the owed
    // bound (one further window after the calendar end: Friday 03-20) the outcome is sealed with its genuine
    // remainder, and the reconciler reports an UNFILLED_REMAINDER break - never a silent, permanent deferral.
    const dead = cal.sessionDates(isoDate("2026-03-10"), isoDate("2026-03-27"));
    const env = setup("SHADOW", true, { vtiVolumeShares: 12_000n, omitSessions: { VTI: dead } });
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    await env.scheduler.tick(afterClose("2026-03-09", 150));
    await env.scheduler.tick(afterClose("2026-03-19", 150));
    const b0At = (): ShadowFillRecord | undefined => fillRecordsOf(env.db).find((r) => r.arm === "B0_PASSIVE" && r.decisionSession === "2026-03-06");
    expect(b0At()).toBeUndefined(); // still inside the grace window
    await env.scheduler.tick(afterClose("2026-03-20", 150));
    const b0 = b0At();
    if (!b0) throw new Error("B0 not finalized at the owed bound");
    expect(b0.fills.map((f) => f.session)).toEqual(["2026-03-09"]);
    expect(b0.unfilled.map((u) => u.reason)).toEqual(["LIQUIDITY"]);
    const breaks = events(env.db, SHADOW_RECONCILED).at(-1)?.["breaks"] as string[];
    expect(breaks.some((b) => b.startsWith(`UNFILLED_REMAINDER:B0_PASSIVE:${afterClose("2026-03-06", 60)}`))).toBe(true);
    expect(breaks.some((b) => b.startsWith(`MISSING_FILL_RECORD:B0_PASSIVE:${afterClose("2026-03-06", 60)}`))).toBe(false);
  });
});

describe("reconciler breaks feed the next decision's halt (D-54)", () => {
  type HaltEvent = { session: string; halt: { from: string; reArmsApplied: { to: string }[]; unresolvedBreaks: string[]; freshBreaks: string[]; acknowledgedBreaks: string[] } };
  const sealedOn = (db: Db, session: string): HaltEvent | undefined => (events(db, "shadow.decision_sealed") as unknown as HaltEvent[]).find((e) => e.session === session);
  const recordsAt = (db: Db, session: string) =>
    (db.prepare("SELECT arm, halt_state, record_json FROM decision_records WHERE decision_at = ?").all(afterClose(session, 60)) as { arm: string; halt_state: string; record_json: string }[]);

  it("holds the book after a break outlives a session, and steps down one level per owner re-arm", async () => {
    // Thin VTI: B0's week-1 buy leaves a LIQUIDITY remainder, finalized at the window end (Friday 03-13) as an
    // UNFILLED_REMAINDER break. The 03-13 decision ran before that reconcile, so it is unaffected; by the 03-20
    // decision the break has been reported for more than a session.
    const env = setup("SHADOW", true, { vtiVolumeShares: 12_000n });
    for (const s of ["2026-03-06", "2026-03-09", "2026-03-13", "2026-03-16", "2026-03-20"]) await env.scheduler.tick(afterClose(s, 150));
    const brk = `UNFILLED_REMAINDER:B0_PASSIVE:${afterClose("2026-03-06", 60)}:VTI`;

    expect(recordsAt(env.db, "2026-03-13").every((r) => r.halt_state !== "HOLD_ONLY")).toBe(true);
    const week3 = sealedOn(env.db, "2026-03-20");
    expect(week3?.halt.unresolvedBreaks).toContain(brk);
    const held = recordsAt(env.db, "2026-03-20");
    expect(held).toHaveLength(2);
    for (const r of held) {
      expect(r.halt_state).toBe("HOLD_ONLY");
      expect(r.record_json).toContain(`reconciliation_unresolved:${brk}`);
    }

    // The week-3 outcomes are recorded against the held decisions. (Whether HOLD_ONLY freezes a held book's EXITS
    // is proven by the dedicated test below: in this fixture B1's week-3 target sits inside the rebalance band,
    // so it has no order at all and an assertion here could not tell a freeze from a quiet week.)
    await env.scheduler.tick(afterClose("2026-03-23", 150));
    expect(fillRecordsOf(env.db).some((r) => r.arm === "B1_DETERMINISTIC" && r.decisionSession === "2026-03-20")).toBe(true);

    // The owner examines every reported break, acknowledges them, and re-arms toward NORMAL; the halt machine
    // stages it to one step: HOLD_ONLY -> HALT_NEW_RISK.
    const reported = (events(env.db, SHADOW_RECONCILED).at(-1)?.["breaks"] as string[] | undefined) ?? [];
    expect(reported).toContain(brk);
    recordShadowReArm(env.db, new Ledger(env.db), {
      charterHash: loadCharterFile(env.charterPath).charterHash,
      to: "NORMAL",
      actor: "Test Owner",
      reason: "thin-volume remainder in the synthetic book; examined, no data fault",
      acknowledge: reported,
      now: "2026-03-24T12:00:00.000Z" as UtcInstant,
    });
    await env.scheduler.tick(afterClose("2026-03-27", 150));
    const week4 = sealedOn(env.db, "2026-03-27");
    expect(week4?.halt.from).toBe("HOLD_ONLY");
    expect(week4?.halt.reArmsApplied.map((r) => r.to)).toEqual(["NORMAL"]);
    expect(week4?.halt.acknowledgedBreaks).toEqual([...new Set(reported)].sort());
    expect(week4?.halt.unresolvedBreaks.filter((b) => reported.includes(b))).toEqual([]);
    for (const r of recordsAt(env.db, "2026-03-27")) expect(r.halt_state).toBe("HALT_NEW_RISK");
  });

  it("a HOLD_ONLY decision freezes a held book's exits, and the fill event counts them (Codex P2, PR #108)", async () => {
    // Week 1 fills a real B1 book. Then a HOLD_ONLY decision asking for a full exit is sealed for 03-13 (copied
    // from week 1's sealed record, so it is a genuine record of this charter). Monday's fill run must sell
    // nothing, record every held entity as a suppressed exit, and report that count on shadow.fills_recorded.
    const env = setup("SHADOW");
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    await env.scheduler.tick(afterClose("2026-03-09", 150));
    const week1 = env.db.prepare("SELECT arm, record_json FROM decision_records ORDER BY arm").all() as { arm: string; record_json: string }[];
    const held = [...new Set((fillRecordsOf(env.db).find((r) => r.arm === "B1_DETERMINISTIC")?.fills ?? []).filter((f) => f.side === "BUY").map((f) => f.entityId))].sort();
    expect(held.length).toBeGreaterThan(0);
    for (const row of week1) {
      const rec = JSON.parse(row.record_json) as ProspectiveDecisionRecord;
      appendDecisionRecord(env.db, {
        ...rec,
        decisionAt: afterClose("2026-03-13", 60),
        sealedAt: afterClose("2026-03-13", 61),
        targetWeights: [],
        cashWeight: "1",
        gate: { newRiskAllowed: false, haltState: "HOLD_ONLY", increasedRisk: [], blockedBy: ["halt RECONCILIATION_UNRESOLVED: test"] },
      });
    }
    // Monday: the decision job does nothing on a non-decision session; the fill job fills the 03-13 decisions.
    await env.scheduler.tick(afterClose("2026-03-16", 150));
    const frozen = fillRecordsOf(env.db).find((r) => r.arm === "B1_DETERMINISTIC" && r.decisionSession === "2026-03-13");
    if (!frozen) throw new Error("no fill record for the HOLD_ONLY decision");
    expect(frozen.fills).toEqual([]);
    expect(frozen.suppressedExits).toEqual(held);
    expect(frozen.suppressedEntries).toEqual([]);
    const reported = (events(env.db, SHADOW_FILLS_RECORDED).at(-1)?.["recorded"] as { arm: string; suppressedEntries: number; suppressedExits: number }[]).find((r) => r.arm === "B1_DETERMINISTIC");
    expect(reported).toMatchObject({ suppressedEntries: 0, suppressedExits: held.length });
  });

  it("refuses a re-arm that would do less than it says: bad state, blank actor or reason, an unreported break", () => {
    const env = setup("SHADOW");
    const charterHash = loadCharterFile(env.charterPath).charterHash;
    const base = { charterHash, to: "HALT_NEW_RISK", actor: "Owner", reason: "reviewed", acknowledge: [] as string[], now: "2026-03-24T12:00:00.000Z" as UtcInstant };
    const ledger = new Ledger(env.db);
    expect(() => recordShadowReArm(env.db, ledger, { ...base, to: "EMERGENCY_FLATTEN_AUTHORIZED" })).toThrow(ShadowReArmError);
    expect(() => recordShadowReArm(env.db, ledger, { ...base, actor: "  " })).toThrow(ShadowReArmError);
    expect(() => recordShadowReArm(env.db, ledger, { ...base, reason: "" })).toThrow(ShadowReArmError);
    expect(() => recordShadowReArm(env.db, ledger, { ...base, acknowledge: ["MISSING_DECISION_RECORD:B1_DETERMINISTIC:2026-03-27"] })).toThrow(/does not report/);
    // Reported once, since cleared: the latest reconcile no longer reports it, so there is no occurrence to resolve.
    ledger.append(SHADOW_RECONCILED, { charterHash, session: "2026-03-20", breaks: ["NEGATIVE_CASH:B1_DETERMINISTIC:2026-03-20"] }, afterClose("2026-03-20", 150));
    ledger.append(SHADOW_RECONCILED, { charterHash, session: "2026-03-23", breaks: [] }, afterClose("2026-03-23", 150));
    expect(() => recordShadowReArm(env.db, ledger, { ...base, acknowledge: ["NEGATIVE_CASH:B1_DETERMINISTIC:2026-03-20"] })).toThrow(/does not report/);
    expect(events(env.db, SHADOW_HALT_REARM)).toHaveLength(0);
    // A well-formed one is recorded.
    recordShadowReArm(env.db, ledger, base);
    expect(events(env.db, SHADOW_HALT_REARM)).toEqual([{ charterHash, to: "HALT_NEW_RISK", actor: "Owner", reason: "reviewed", acknowledgedBreaks: [] }]);
  });

  it("finds the decision the job will seal next from persisted run and seal state, not the wall clock (Codex P2s, PR #108)", () => {
    const env = setup("SHADOW");
    const charterHash = loadCharterFile(env.charterPath).charterHash;
    const next = (now: UtcInstant) => upcomingShadowDecision(env.db, cal, { charterHash, decisionOffsetMinutes: 60, now });
    const friday = { decisionAt: afterClose("2026-03-06", 60), session: "2026-03-06" };
    const nextFriday = { decisionAt: afterClose("2026-03-13", 60), session: "2026-03-13" };
    const runAt = afterClose("2026-03-06", 150);

    expect(next("2026-03-06T15:00:00.000Z" as UtcInstant)).toEqual(friday); // Friday morning
    expect(next(afterClose("2026-03-06", 90))).toEqual(friday); // past the instant, before the delayed run
    // Due but not yet ticked: the scheduler still runs it late, inside its 24 h lookback - still Friday's.
    expect(next(afterClose("2026-03-06", 150 + 60))).toEqual(friday);
    // Never recorded and beyond the lookback: no tick will run it.
    expect(next(afterClose("2026-03-06", 150 + 25 * 60))).toEqual(nextFriday);

    // One sealed arm is not a finished decision: the job completes the pair.
    env.db
      .prepare("INSERT INTO decision_records (decision_at, sealed_at, strategy_id, strategy_version, charter_hash, arm, mode, new_risk_allowed, halt_state, record_json, record_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(friday.decisionAt, friday.decisionAt, "etf-trend-vol", "0.2.0", charterHash, "B0_PASSIVE", "SHADOW", 1, "NORMAL", "{}", "sha256:partial");
    expect(next(afterClose("2026-03-06", 90))).toEqual(friday);

    // A finished run for the instant, even one that sealed nothing (e.g. a visible skip), moves on.
    env.db.prepare("INSERT INTO job_runs (idempotency_key, job_id, scheduled_for, status) VALUES (?,?,?,?)").run("k-fri", "shadow_decision", runAt, "succeeded");
    expect(next(afterClose("2026-03-06", 160))).toEqual(nextFriday);
  });

  it("treats an instant as finished once every shadow arm is sealed, whatever the run state", async () => {
    const env = setup("SHADOW");
    const charterHash = loadCharterFile(env.charterPath).charterHash;
    await env.scheduler.tick(afterClose("2026-03-06", 150)); // seals both arms
    env.db.prepare("DELETE FROM job_runs").run(); // only the seal remains as evidence
    expect(upcomingShadowDecision(env.db, cal, { charterHash, decisionOffsetMinutes: 60, now: afterClose("2026-03-06", 90) })).toEqual({ decisionAt: afterClose("2026-03-13", 60), session: "2026-03-13" });
  });

  it("shadow status classifies breaks as the NEXT decision will, not as of the moment it runs (Codex P2, PR #108)", () => {
    // A break first reported Thursday 03-12. On Friday morning the next decision is Friday's, which compares it
    // with Friday and holds the book on it - so status must call it unresolved, not fresh.
    const env = setup("SHADOW");
    const charterHash = loadCharterFile(env.charterPath).charterHash;
    const brk = "MISSING_DECISION_RECORD:B1_DETERMINISTIC:2026-03-06";
    new Ledger(env.db).append(SHADOW_RECONCILED, { charterHash, session: "2026-03-12", breaks: [brk] }, afterClose("2026-03-12", 150));
    const status = shadowStatusForNextDecision(env.db, cal, { charterHash, decisionOffsetMinutes: 60, now: "2026-03-13T15:00:00.000Z" as UtcInstant });
    expect(status.nextDecision).toEqual({ decisionAt: afterClose("2026-03-13", 60), session: "2026-03-13" });
    expect(status.unresolvedBreaks).toEqual([brk]);
    expect(status.freshBreaks).toEqual([]);
  });

  it("drops a malformed re-arm written to the ledger directly: relaxing a halt needs a well-formed owner action", () => {
    const env = setup("SHADOW");
    const charterHash = loadCharterFile(env.charterPath).charterHash;
    const ledger = new Ledger(env.db);
    const at = "2026-03-24T12:00:00.000Z" as UtcInstant;
    ledger.append(SHADOW_HALT_REARM, { charterHash, to: "BOGUS", actor: "Owner", reason: "x", acknowledgedBreaks: [] }, at);
    ledger.append(SHADOW_HALT_REARM, { charterHash, to: "NORMAL", actor: " ", reason: "x", acknowledgedBreaks: [] }, at);
    ledger.append(SHADOW_HALT_REARM, { charterHash, to: "NORMAL", actor: "Owner", reason: "", acknowledgedBreaks: [] }, at);
    ledger.append(SHADOW_HALT_REARM, { charterHash, to: "HALT_NEW_RISK", actor: "Owner", reason: "ok", acknowledgedBreaks: ["x", 7] }, at);
    const { reArms } = readShadowHaltInputs(env.db, charterHash, "2026-03-25T00:00:00.000Z" as UtcInstant);
    expect(reArms).toEqual([{ to: "HALT_NEW_RISK", actor: "Owner", at, reason: "ok", acknowledgedBreaks: ["x"] }]);
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
  const base = { calendar: cal, arms: ["B0_PASSIVE", "B1_DETERMINISTIC"], delayBars: 1, maxFillBars: 5, bookCash: new Map() };

  it("flags a weekly decision session an arm failed to seal, from the first sealed session onward", () => {
    const breaks = reconcileShadow({
      ...base,
      sealed: [sealed("B0_PASSIVE", "2026-03-06"), sealed("B1_DETERMINISTIC", "2026-03-06"), sealed("B0_PASSIVE", "2026-03-13")],
      fillRecords: [fillFor("B0_PASSIVE", "2026-03-06"), fillFor("B1_DETERMINISTIC", "2026-03-06"), fillFor("B0_PASSIVE", "2026-03-13")],
      throughSession: isoDate("2026-03-16"),
    });
    expect(breaks).toEqual(["MISSING_DECISION_RECORD:B1_DETERMINISTIC:2026-03-13"]);
  });

  it("flags a sealed decision whose owed session has passed with no recorded outcome - and not before it is owed", () => {
    const sealedRecords = [sealed("B0_PASSIVE", "2026-03-06"), sealed("B1_DETERMINISTIC", "2026-03-06")];
    // The calendar window ends Friday 2026-03-13 (delay 1 + 5 bars), but the fill job may still be waiting on
    // the entity's OWN bars to cover it, so the outcome is owed only one further window later: Friday
    // 2026-03-20. Before that, a deferral is legitimate and must not read as a missing record.
    const missingFills = (through: string): string[] =>
      reconcileShadow({ ...base, sealed: sealedRecords, fillRecords: [], throughSession: isoDate(through) }).filter((b) => b.startsWith("MISSING_FILL_RECORD"));
    expect(missingFills("2026-03-06")).toEqual([]);
    expect(missingFills("2026-03-13")).toEqual([]);
    expect(missingFills("2026-03-19")).toEqual([]);
    // At the owed bound, both outcomes are owed.
    expect(reconcileShadow({ ...base, sealed: sealedRecords, fillRecords: [], throughSession: isoDate("2026-03-20") }).filter((b) => b.startsWith("MISSING_FILL_RECORD"))).toEqual([
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

  it("fillWindowEndSession includes the zero-delay decision-bar attempt (Codex P2, PR #102 round 2)", () => {
    // Zero delay: the decision-bar attempt, then the loop's five bars starting the NEXT session -> Friday 03-13.
    // The old `delay + bars - 1` formula said Thursday 03-12, one bar early.
    expect(fillWindowEndSession(cal, isoDate("2026-03-06"), 0, 5)).toBe("2026-03-13");
    expect(fillWindowEndSession(cal, isoDate("2026-03-06"), 1, 5)).toBe("2026-03-13");
    expect(fillWindowEndSession(cal, isoDate("2026-03-06"), 2, 5)).toBe("2026-03-16");
    // The owed bound is one further full window.
    expect(fillOwedSession(cal, isoDate("2026-03-06"), 0, 5)).toBe("2026-03-20");
    expect(fillOwedSession(cal, isoDate("2026-03-06"), 2, 5)).toBe("2026-03-23");
  });
});
