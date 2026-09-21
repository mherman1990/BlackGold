import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { addMs, isoDate, sha256Hex, type Db, type UtcInstant } from "@blackgold/shared";
import { Ledger, NyseCalendar, PointInTimeRepository, Scheduler, corporateActionObservation, openCoreDb } from "../src/index.ts";
import { EntityMap } from "../src/market/entity-map.ts";
import { parseAppConfig } from "../src/config/load.ts";
import type { AppConfig } from "../src/config/schema.ts";
import { isWeeklyDecisionSession, registerShadowDecisionJob, SHADOW_DECISION_SEALED } from "../src/decision/shadow-job.ts";
import { appendDecisionRecord, decisionRecordCount, DECISION_RECORD_VERSION } from "../src/decision/decision-record.ts";
import { loadCharterFile } from "../src/strategy/charter.ts";
import { buildMarket, D, N, type PricePath } from "./strategy-fixture.ts";

const cal = new NyseCalendar();
const afterClose = (session: string, mins: number): UtcInstant => addMs(cal.sessionClose(isoDate(session)), mins * 60_000);

/**
 * The registered charter, shrunk to the shadow-decision fixture's shape (same edits as shadow-decision.test.ts)
 * and written back to disk, because the job loads a charter FILE. The parse -> edit -> stringify round trip
 * keeps it a valid document under the real schema.
 */
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
  // Unlike the in-memory fixtures, a charter FILE goes through full validation: factor assignments must cover
  // only universe members, and the registered feature point must be a member of the sensitivity grid.
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

/** The baked policy directory: a relaxed risk.yaml, a clean restricted list, and a covering theme membership. */
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

/** Register a minimal rung-1 experiment for the charter hash, the precondition the job enforces (D-53). */
function registerExperimentFor(db: Db, charterHash: string, registeredAt = "2026-03-01T00:00:00Z"): void {
  db.prepare(
    "INSERT INTO experiments (experiment_id, registered_at, registered_by, definition_json, definition_hash, labels_json) VALUES (?,?,?,?,?,?)",
  ).run(`exp-${sha256Hex(charterHash).slice(0, 8)}`, registeredAt, "test", JSON.stringify({ charter: { strategy_id: "etf-trend-vol", charter_version: "0.2.0", charter_hash: charterHash } }), `sha256:${sha256Hex(charterHash)}`, "[]");
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

function setup(mode: "SHADOW" | "RESEARCH", withCharterPath = true, opts: { registerExperiment?: boolean; approveRestrictedList?: boolean } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "bg-shadowjob-"));
  const db = openCoreDb({ dbPath: join(dir, "s.sqlite") }).db;
  buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-03-13"), db });
  const charterPath = writeShadowCharter(dir);
  if (opts.registerExperiment !== false) registerExperimentFor(db, loadCharterFile(charterPath).charterHash);
  writePolicyDir(dir, opts);
  const config = parseAppConfig({ mode, shadow: { ...(withCharterPath ? { charterPath } : {}), policyDir: dir } });
  const scheduler = new Scheduler({ db, ledger: new Ledger(db), calendar: cal, dueLookbackMs: 4 * 3_600_000, missedLookbackMs: 48 * 3_600_000 });
  registerShadowDecisionJob(scheduler, { config, calendar: cal });
  return { db, scheduler, config, charterPath, policyDir: dir };
}

const jobIds = (s: Scheduler): string[] => s.registeredJobs().map((j) => j.jobId);

function sealedEvents(db: Db): { session: string; decisionAt: string; policyHashes: Record<string, string>; sealed: { arm: string; newRiskAllowed: boolean }[]; alreadySealed: string[] }[] {
  const rows = db.prepare("SELECT payload FROM ledger_events WHERE kind = ?").all(SHADOW_DECISION_SEALED) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as ReturnType<typeof sealedEvents>[number]);
}

describe("registerShadowDecisionJob gating", () => {
  it("registers only when a shadow charter is configured AND the mode seals prospective decisions", () => {
    expect(jobIds(setup("SHADOW").scheduler)).toContain("shadow_decision");
    // RESEARCH may not seal a prospective decision record; the job must not even exist in that process.
    expect(jobIds(setup("RESEARCH").scheduler)).not.toContain("shadow_decision");
    // No charter configured: opt-in default is off.
    expect(jobIds(setup("SHADOW", false).scheduler)).not.toContain("shadow_decision");
  });
});

describe("shadow_decision job", () => {
  // 2026-03-06 is a Friday (the weekly decision session); 2026-03-04 a Wednesday.
  it("seals both arms at the charter's decision instant on a weekly decision session, with the policy hashes in the ledger", async () => {
    const env = setup("SHADOW");
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    expect(decisionRecordCount(env.db)).toBe(2);

    const events = sealedEvents(env.db);
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (!ev) throw new Error("no sealed event");
    expect(ev.session).toBe("2026-03-06");
    // The decision instant is the charter's registered close + decision_offset_minutes (60), not the run time.
    expect(ev.decisionAt).toBe(afterClose("2026-03-06", 60));
    expect(ev.sealed.map((s) => s.arm).sort()).toEqual(["B0_PASSIVE", "B1_DETERMINISTIC"]);
    // Each policy hash is the sha256 of the exact file bytes the run read.
    for (const [key, file] of [
      ["risk_yaml", "risk.yaml"],
      ["restricted_list_yaml", "restricted-list.yaml"],
      ["theme_membership_yaml", "theme-membership.yaml"],
    ] as const) {
      expect(ev.policyHashes[key]).toBe(`sha256:${sha256Hex(readFileSync(join(env.policyDir, file)))}`);
    }
  });

  it("seals nothing on a non-decision session (the charter's weekly cadence, not the job's daily schedule)", async () => {
    const env = setup("SHADOW");
    await env.scheduler.tick(afterClose("2026-03-04", 150));
    expect(decisionRecordCount(env.db)).toBe(0);
    expect(sealedEvents(env.db)).toHaveLength(0);
  });

  const preSealB0 = (env: Env, charterHash: string): void => {
    appendDecisionRecord(env.db, {
      recordVersion: DECISION_RECORD_VERSION,
      strategyId: "etf-trend-vol",
      strategyVersion: "0.2.0",
      charterHash,
      arm: "B0_PASSIVE",
      mode: "SHADOW",
      decisionAt: afterClose("2026-03-06", 60),
      sealedAt: afterClose("2026-03-06", 61),
      snapshotIds: [],
      targetWeights: [{ entityId: "VTI", weight: "1" }],
      cashWeight: "0",
      gate: { newRiskAllowed: true, haltState: "NORMAL", increasedRisk: [], blockedBy: [] },
      constructionVersion: 1,
      notes: [],
    });
  };

  it("skips an arm already sealed for the instant UNDER THE SAME CONTEXT instead of overwriting or failing the run", async () => {
    const env = setup("SHADOW");
    // A prior run of THIS charter sealed B0 for this instant (e.g. it crashed mid-loop). The instant is immutable.
    preSealB0(env, loadCharterFile(env.charterPath).charterHash);
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    expect(decisionRecordCount(env.db)).toBe(2); // the pre-sealed B0 plus the run's B1
    const ev = sealedEvents(env.db)[0];
    if (!ev) throw new Error("no sealed event");
    expect(ev.alreadySealed).toEqual(["B0_PASSIVE"]);
    expect(ev.sealed.map((s) => s.arm)).toEqual(["B1_DETERMINISTIC"]);
  });

  it("refuses to complete an arm pair when the pre-sealed arm was written under a DIFFERENT charter (Codex P2, round 7)", async () => {
    const env = setup("SHADOW");
    // Another writer sealed B0 under some other charter hash. Sealing B1 under the current charter would leave
    // a "synchronized" pair whose arms describe different experiments; the run must fail and roll back instead.
    preSealB0(env, `sha256:${"0".repeat(64)}`);
    const outcomes = await env.scheduler.tick(afterClose("2026-03-06", 150));
    expect(outcomes.find((o) => o.jobId === "shadow_decision")?.status).toBe("failed");
    expect(outcomes.find((o) => o.jobId === "shadow_decision")?.error).toContain("different context");
    expect(decisionRecordCount(env.db)).toBe(1); // only the foreign B0; the transaction rolled back, no B1
    expect(sealedEvents(env.db)).toHaveLength(0); // and no event attributing the pair to the current charter
  });
});

describe("shadow_decision job: rung order and policy approval", () => {
  it("seals nothing while no experiment is registered for the charter hash (rung-1 precedes rung-2, D-53)", async () => {
    const env = setup("SHADOW", true, { registerExperiment: false });
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    expect(decisionRecordCount(env.db)).toBe(0);
    const skips = env.db.prepare("SELECT payload FROM ledger_events WHERE kind = 'shadow.decision_skipped'").all() as { payload: string }[];
    expect(skips).toHaveLength(1);
    expect(skips[0]?.payload).toContain("no experiment registered");
  });

  it("treats an incomplete or future approval as unapproved: empty signer, missing timestamp, future timestamp (Codex P1, round 4)", async () => {
    for (const approval of [
      { approvedBy: "  ", approvedAt: "2026-03-01T00:00:00Z" }, // whitespace signer
      { approvedBy: "Test Owner" }, // no timestamp
      { approvedBy: "Test Owner", approvedAt: "2027-01-01T00:00:00Z" }, // future timestamp
    ]) {
      const env = setup("SHADOW");
      writeFileSync(join(env.policyDir, "restricted-list.yaml"), stringify({ ...approval, asOf: "2026-03-01", themes: ["soybean_processing"] }));
      await env.scheduler.tick(afterClose("2026-03-06", 150));
      const rows = env.db.prepare("SELECT record_json FROM decision_records").all() as { record_json: string }[];
      expect(rows.length).toBe(2);
      for (const row of rows) {
        const rec = JSON.parse(row.record_json) as { gate: { newRiskAllowed: boolean; blockedBy: string[] } };
        expect(rec.gate.newRiskAllowed).toBe(false);
        expect(rec.gate.blockedBy.join(" ")).toContain("policy_unapproved:restricted-list.yaml");
      }
    }
  });

  it("ignores an experiment registered AFTER the decision instant, even when it exists by run time (Codex P1, round 5)", async () => {
    const env = setup("SHADOW", true, { registerExperiment: false });
    // Registered at close+120: after the decision instant (close+60) but before the job runs (close+150).
    registerExperimentFor(env.db, loadCharterFile(env.charterPath).charterHash, afterClose("2026-03-06", 120));
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    expect(decisionRecordCount(env.db)).toBe(0);
    const skips = env.db.prepare("SELECT payload FROM ledger_events WHERE kind = 'shadow.decision_skipped'").all() as { payload: string }[];
    expect(skips[0]?.payload).toContain("at the decision instant");
  });

  it("treats an approval stamped AFTER the decision instant as unapproved, even when it exists by run time (Codex P1, round 5)", async () => {
    const env = setup("SHADOW");
    // Approved at close+120: after the decision instant (close+60) but before the job runs (close+150).
    writeFileSync(
      join(env.policyDir, "restricted-list.yaml"),
      stringify({ approvedBy: "Test Owner", approvedAt: afterClose("2026-03-06", 120), asOf: "2026-03-01", themes: ["soybean_processing"] }),
    );
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    const rows = env.db.prepare("SELECT record_json FROM decision_records").all() as { record_json: string }[];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const rec = JSON.parse(row.record_json) as { gate: { newRiskAllowed: boolean; blockedBy: string[] } };
      expect(rec.gate.newRiskAllowed).toBe(false);
      expect(rec.gate.blockedBy.join(" ")).toContain("policy_unapproved:restricted-list.yaml");
    }
  });

  it("compares approval timestamps as instants, not strings: no-millis at exactly decisionAt is approved (Codex P2, round 6)", async () => {
    const env = setup("SHADOW");
    // The same instant as decisionAt (close+60) but encoded without fractional seconds. Lexically
    // "...T22:00:00Z" > "...T22:00:00.000Z", so a string compare would wrongly reject this approval.
    const atDecisionNoMillis = afterClose("2026-03-06", 60).replace(".000Z", "Z");
    expect(atDecisionNoMillis.endsWith(".000Z")).toBe(false); // the fixture really spans the encoding dimension
    writeFileSync(
      join(env.policyDir, "restricted-list.yaml"),
      stringify({ approvedBy: "Test Owner", approvedAt: atDecisionNoMillis, asOf: "2026-03-01", themes: ["soybean_processing"] }),
    );
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    const rows = env.db.prepare("SELECT record_json FROM decision_records").all() as { record_json: string }[];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const rec = JSON.parse(row.record_json) as { gate: { blockedBy: string[] } };
      expect(rec.gate.blockedBy.join(" ")).not.toContain("policy_unapproved:restricted-list.yaml");
    }
  });

  it("seals every arm with new risk BLOCKED while any policy file is unapproved (placeholder content is not policy)", async () => {
    const env = setup("SHADOW", true, { approveRestrictedList: false });
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    expect(decisionRecordCount(env.db)).toBe(2); // the records still seal - honestly blocked, not silently absent
    const rows = env.db.prepare("SELECT record_json FROM decision_records").all() as { record_json: string }[];
    for (const row of rows) {
      const rec = JSON.parse(row.record_json) as { gate: { newRiskAllowed: boolean; blockedBy: string[] } };
      expect(rec.gate.newRiskAllowed).toBe(false);
      expect(rec.gate.blockedBy.join(" ")).toContain("policy_unapproved:restricted-list.yaml");
    }
    const ev = sealedEvents(env.db)[0] as (ReturnType<typeof sealedEvents>[number] & { unapprovedPolicies: string[] }) | undefined;
    expect(ev?.unapprovedPolicies).toEqual(["policy_unapproved:restricted-list.yaml"]);
  });
});

describe("shadow_decision job: identity and atomicity", () => {
  const recordJson = (db: Db, arm: string): string =>
    (db.prepare("SELECT record_json FROM decision_records WHERE arm = ?").get(arm) as { record_json: string }).record_json;

  it("blocks a restricted issuer listed under its OLD ticker after a symbol change (Codex P1)", async () => {
    // The restricted list names the historical ticker; today's holdings trade under the new one. Identity must
    // carry the entity's full known ticker history or the rename silently un-restricts the issuer.
    const withAlias = setup("SHADOW");
    writeFileSync(join(withAlias.policyDir, "restricted-list.yaml"), stringify({ ...APPROVAL, asOf: "2026-03-01", names: ["OLDQQQ"] }));
    const map = new EntityMap(withAlias.db);
    map.register({ symbol: "OLDQQQ", entityId: "QQQ_TRUST", effectiveFrom: D("2020-01-02"), effectiveTo: D("2025-12-31"), source: "test" });
    map.register({ symbol: "QQQ", entityId: "QQQ_TRUST", effectiveFrom: D("2026-01-01"), source: "test" });
    await withAlias.scheduler.tick(afterClose("2026-03-06", 150));
    const blocked = JSON.parse(recordJson(withAlias.db, "B1_DETERMINISTIC")) as { gate: { newRiskAllowed: boolean; blockedBy: string[] } };
    expect(blocked.gate.newRiskAllowed).toBe(false);
    expect(blocked.gate.blockedBy.join(" ")).toContain("RESTRICTED_NAME: QQQ");
    // Key alignment (Codex P1, round 2): the stable entity id lives in `identifiers`, never in the candidate's
    // canonical key, so a MAPPED but unrestricted holding is still covered rather than MISSING_COMPLIANCE.
    expect(blocked.gate.blockedBy.join(" ")).not.toContain("MISSING_COMPLIANCE");

    // Control (the fixture spans the dimension): the same restricted list WITHOUT the entity-map history does
    // not connect OLDQQQ to QQQ, so B1 is not blocked by it.
    const noAlias = setup("SHADOW");
    writeFileSync(join(noAlias.policyDir, "restricted-list.yaml"), stringify({ ...APPROVAL, asOf: "2026-03-01", names: ["OLDQQQ"] }));
    await noAlias.scheduler.tick(afterClose("2026-03-06", 150));
    const clear = JSON.parse(recordJson(noAlias.db, "B1_DETERMINISTIC")) as { gate: { blockedBy: string[] } };
    expect(clear.gate.blockedBy.join(" ")).not.toContain("RESTRICTED_NAME");
  });

  it("resolves ticker history from INGESTED symbol-change actions via syncFromRepository (Codex P1, round 2)", async () => {
    // Production never calls EntityMap.register by hand: a rename arrives as a corporate_action.SYMBOL_CHANGE
    // observation. The job must sync the map from the store or the history silently resolves to nothing.
    const env = setup("SHADOW");
    writeFileSync(join(env.policyDir, "restricted-list.yaml"), stringify({ ...APPROVAL, asOf: "2026-03-01", names: ["OLDQQQ"] }));
    // NOTHING pre-seeds the old ticker (Codex P1, round 6): on an ingestion-only database the SYMBOL_CHANGE
    // observation is the ONLY thing that ever links OLDQQQ to the entity, so applyAction must materialize the
    // old symbol's history from the action itself or the restricted-list entry is silently bypassed.
    const pit = new PointInTimeRepository(env.db);
    pit.append(
      corporateActionObservation(
        { kind: "SYMBOL_CHANGE", entityId: "QQQ", oldSymbol: "OLDQQQ", newSymbol: "QQQ", effective: D("2026-01-15") },
        {
          sourceLocator: "test/symbol-change/QQQ",
          availableAt: afterClose("2026-01-15", 60),
          ingestedAt: afterClose("2026-01-15", 60),
          rawContentHash: `sha256:${sha256Hex("sym")}`,
          adapterVersion: "1.0.0",
          parserVersion: "1.0.0",
        },
      ),
    );
    await env.scheduler.tick(afterClose("2026-03-06", 150));
    const rec = JSON.parse(recordJson(env.db, "B1_DETERMINISTIC")) as { gate: { blockedBy: string[] } };
    expect(rec.gate.blockedBy.join(" ")).toContain("RESTRICTED_NAME: QQQ");
    expect(rec.gate.blockedBy.join(" ")).not.toContain("MISSING_COMPLIANCE");
  });

  it("derives the schedule from the charter's decision offset so the run can never fire before the instant (Codex P2)", async () => {
    // A charter registering a 300-minute decision offset: the fixed 150-minute schedule would consume the
    // scheduler's idempotency key on a pre-instant skip and lose that week's records for good.
    const dir = mkdtempSync(join(tmpdir(), "bg-shadowjob-"));
    const db = openCoreDb({ dbPath: join(dir, "s.sqlite") }).db;
    buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-03-13"), db });
    const charterPath = writeShadowCharter(dir, 300);
    registerExperimentFor(db, loadCharterFile(charterPath).charterHash);
    writePolicyDir(dir);
    const config = parseAppConfig({ mode: "SHADOW", shadow: { charterPath, policyDir: dir } });
    const scheduler = new Scheduler({ db, ledger: new Ledger(db), calendar: cal, dueLookbackMs: 8 * 3_600_000, missedLookbackMs: 48 * 3_600_000 });
    registerShadowDecisionJob(scheduler, { config, calendar: cal });
    // At close+150 nothing is due yet (the schedule is charter-derived: 300+30 minutes)...
    await scheduler.tick(afterClose("2026-03-06", 150));
    expect(decisionRecordCount(db)).toBe(0);
    // ...and once it fires, the decision instant is the charter's close+300 and both arms seal.
    await scheduler.tick(afterClose("2026-03-06", 340));
    expect(decisionRecordCount(db)).toBe(2);
    const ev = sealedEvents(db)[0];
    if (!ev) throw new Error("no sealed event");
    expect(ev.decisionAt).toBe(afterClose("2026-03-06", 300));
  });

  it("recovers the ORIGINATING session when the offset carries the run past later sessions' closes (Codex P2, round 7)", async () => {
    // A schema-valid 4320-minute (3-day) decision offset: the run for Friday 2026-03-06 fires Monday evening,
    // AFTER Monday's close. Reconstructing the session from the run time would land on Monday - a non-decision
    // session - and silently drop the Friday decision forever. The session must be recovered by inverting the
    // schedule (scheduledFor - jobOffset = the originating close).
    const dir = mkdtempSync(join(tmpdir(), "bg-shadowjob-"));
    const db = openCoreDb({ dbPath: join(dir, "s.sqlite") }).db;
    buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-03-13"), db });
    const charterPath = writeShadowCharter(dir, 4320);
    registerExperimentFor(db, loadCharterFile(charterPath).charterHash);
    writePolicyDir(dir);
    const config = parseAppConfig({ mode: "SHADOW", shadow: { charterPath, policyDir: dir } });
    const scheduler = new Scheduler({ db, ledger: new Ledger(db), calendar: cal, dueLookbackMs: 8 * 3_600_000, missedLookbackMs: 48 * 3_600_000 });
    registerShadowDecisionJob(scheduler, { config, calendar: cal });
    await scheduler.tick(afterClose("2026-03-06", 4350)); // Friday close + 4350 min = Monday 2026-03-09 evening
    expect(decisionRecordCount(db)).toBe(2);
    const ev = sealedEvents(db)[0];
    if (!ev) throw new Error("no sealed event");
    expect(ev.session).toBe("2026-03-06"); // the Friday that generated the run, not Monday
    expect(ev.decisionAt).toBe(afterClose("2026-03-06", 4320));
  });

  it("seals all arms and the ledger event atomically: a failure mid-run leaves no partial records (Codex P1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-shadowjob-"));
    const db = openCoreDb({ dbPath: join(dir, "s.sqlite") }).db;
    buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-03-13"), db });
    const charterPath = writeShadowCharter(dir);
    registerExperimentFor(db, loadCharterFile(charterPath).charterHash);
    writePolicyDir(dir);
    const config = parseAppConfig({ mode: "SHADOW", shadow: { charterPath, policyDir: dir } });
    // A ledger whose sealed-event append throws stands in for a crash after the record inserts: without the
    // transaction, the two decision records would stay committed while the run is recorded failed and the
    // scheduler's claimed (jobId, scheduledFor) key prevents any retry - a permanently half-sealed instant.
    class FailingLedger extends Ledger {
      override append(kind: string, payload: unknown, at?: never): ReturnType<Ledger["append"]> {
        if (kind === SHADOW_DECISION_SEALED) throw new Error("simulated crash before the sealed event");
        return super.append(kind, payload, at);
      }
    }
    const scheduler = new Scheduler({ db, ledger: new FailingLedger(db), calendar: cal, dueLookbackMs: 4 * 3_600_000, missedLookbackMs: 48 * 3_600_000 });
    registerShadowDecisionJob(scheduler, { config, calendar: cal });
    const outcomes = await scheduler.tick(afterClose("2026-03-06", 150));
    expect(outcomes.find((o) => o.jobId === "shadow_decision")?.status).toBe("failed");
    // All-or-nothing: no record survives the failed run.
    expect(decisionRecordCount(db)).toBe(0);
  });
});

describe("isWeeklyDecisionSession", () => {
  it("is true only on the last session of the exchange week, including a holiday-shortened one", () => {
    expect(isWeeklyDecisionSession(cal, D("2026-03-06"))).toBe(true); // Friday
    expect(isWeeklyDecisionSession(cal, D("2026-03-04"))).toBe(false); // Wednesday
    expect(isWeeklyDecisionSession(cal, D("2026-03-05"))).toBe(false); // Thursday of a full week
    // Good Friday 2026 is April 3: Thursday April 2 ends that exchange week.
    expect(isWeeklyDecisionSession(cal, D("2026-04-02"))).toBe(true);
    expect(isWeeklyDecisionSession(cal, D("2026-04-03"))).toBe(false); // not a session at all
  });
});
