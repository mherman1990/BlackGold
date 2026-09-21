import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dec, utc, type Db, type Mode, type UtcInstant } from "@blackgold/shared";
import { openCoreDb } from "../src/index.ts";
import { charterHash, type Charter } from "../src/strategy/charter.ts";
import { RestrictedListConfigSchema, RiskConfigSchema, type RestrictedListConfig, type RiskConfig } from "../src/config/schema.ts";
import { backtestParamsFromCharter, costsFromCharter, runBacktest, type BacktestInput } from "../src/research/backtest.ts";
import { deterministicTargetBook, type DecisionEngineDeps } from "../src/decision/prospective.ts";
import {
  appendDecisionRecord,
  DecisionAlreadySealedError,
  DecisionModeError,
  sealDecision,
} from "../src/decision/decision-record.ts";
import { EMPTY_SHADOW_BOOK, shadowDecisionRecords, type ShadowDecisionContext } from "../src/decision/shadow-decision.ts";
import { buildMarket, fixtureCharter, D, N, type PricePath } from "./strategy-fixture.ts";

// The slice-2a fixture charter (short feature windows), with clusters removed. Construction and candidate
// selection do not read clusters (only the risk-limit engine does), so the target book is identical to the
// clustered fixture, while dropping clusters keeps these gate-composition tests from tripping the separate
// cluster-membership limit that limits.test.ts already covers.
function shadowCharter(): Charter {
  const c = fixtureCharter();
  c.universe.risk_etfs = ["VTI", "QQQ", "IWM", "VTV", "VUG", "XLK", "XLV", "XLU"];
  c.universe.conditional = [];
  c.universe.look_through_flagged = [];
  c.sizing.clusters = [];
  c.features = { ...c.features, momentum_lookback_sessions: 20, momentum_skip_sessions: 4, trend_sma_sessions: 10, volatility_sessions: 15, adv_sessions: 5, min_adv_usd: "1000000" };
  return c;
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

/**
 * The market, charter and decision instant every case in this file decides at, built once.
 *
 * Two things were being paid per test and neither could differ between them. The fixture market is seeded
 * from a closed-form price path and is only ever read here - `runBacktest`, `deterministicTargetBook` and
 * `shadowDecisionRecords` all take a `ReadOnlyPointInTime` and cannot append - so one market cannot couple
 * the cases. And `baseContext` called `fixture()` itself, so a test that also called it directly built the
 * whole thing twice. The charter is cloned per call, because a case may narrow its own copy.
 *
 * The window is the shortest that reaches a decision: the fixture ends a fortnight after the backtest's
 * `from`, because only `decisions.at(0)` is read. The feature windows (20 + 4 momentum sessions, 15 for
 * volatility) still warm up over January and February exactly as they did over a four-month run - the same
 * code, at the same instant, on the same reads.
 */
type Fixture = { charter: Charter; deps: DecisionEngineDeps; decisionAt: UtcInstant };
let built: Fixture | undefined;

function fixture(): Fixture {
  if (built === undefined) {
    const charter = shadowCharter();
    const market = buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-03-13") });
    const input: BacktestInput = {
      charter,
      charterHash: "sha256:" + "0".repeat(64),
      pit: market.pit,
      calendar: market.calendar,
      from: D("2026-03-02"),
      to: D("2026-03-13"),
      initialCash: N("100000"),
      costs: costsFromCharter(charter, "base"),
      params: backtestParamsFromCharter(charter),
    };
    const first = runBacktest(input).decisions.at(0);
    if (first === undefined) throw new Error("fixture produced no backtest decision");
    built = { charter, deps: { pit: market.pit, calendar: market.calendar }, decisionAt: first.decisionAt };
  }
  return { ...built, charter: structuredClone(built.charter) };
}

/** A restricted list that is fresh at the decision instant and restricts nothing, so compliance turns on look-through. */
function cleanList(decisionAt: UtcInstant): RestrictedListConfig {
  return RestrictedListConfigSchema.parse({ asOf: decisionAt.slice(0, 10) });
}

/** Risk config with concentration and per-instrument caps relaxed, isolating halt and compliance in the gate. */
function relaxedRisk(): RiskConfig {
  const risk = RiskConfigSchema.parse({});
  return {
    ...risk,
    positionLimits: { ...risk.positionLimits, maxSingleEtfWeightPct: "1.00", maxOpenPositions: 50 },
    concentration: { ...risk.concentration, maxSectorWeightPct: "1.00", maxThemeWeightPct: "1.00", maxFactorWeightPct: "1.00", maxCorrelatedClusterWeightPct: "1.00" },
    exposure: { ...risk.exposure, minCashPct: "0.00" },
  };
}

function baseContext(overrides: Partial<ShadowDecisionContext> = {}): ShadowDecisionContext {
  const { charter, deps, decisionAt } = fixture();
  return {
    mode: "SHADOW",
    charterHash: charterHash(charter),
    risk: relaxedRisk(),
    restrictedList: cleanList(decisionAt),
    deps,
    decisionAt,
    sealedAt: utc(new Date(Date.parse(decisionAt) + 60_000).toISOString()),
    ...overrides,
  };
}

function newDb(): Db {
  return openCoreDb({ dbPath: join(mkdtempSync(join(tmpdir(), "bg-shadow-")), "d.sqlite") }).db;
}

describe("shadowDecisionRecords: shape and mode guard", () => {
  it("refuses a mode that may not seal a prospective decision", () => {
    const { charter } = fixture();
    expect(() => shadowDecisionRecords(charter, baseContext({ mode: "RESEARCH" as Mode }))).toThrow(DecisionModeError);
    expect(() => shadowDecisionRecords(charter, baseContext({ mode: "BACKTEST" as Mode }))).toThrow(DecisionModeError);
  });

  it("returns both deterministic arms, sealable, with the target weights as decimal strings", () => {
    const { charter } = fixture();
    const records = shadowDecisionRecords(charter, baseContext({ lookThrough: () => [] }));
    expect(records.map((r) => r.arm)).toEqual(["B0_PASSIVE", "B1_DETERMINISTIC"]);
    for (const r of records) {
      expect(r.mode).toBe("SHADOW");
      expect(r.strategyId).toBe(charter.strategy_id);
      expect(r.strategyVersion).toBe(charter.charter_version);
      expect(r.constructionVersion).toBe(charter.component_versions.portfolio_construction);
      // Every weight is a plain decimal string, never a dollar; sealing runs the redaction guard and hashes it.
      for (const w of r.targetWeights) expect(w.weight).toMatch(/^\d+(\.\d+)?$/);
      expect(sealDecision(r).hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("B1's sealed weights are byte-for-byte the deterministic target book (the anti-drift binding)", () => {
    const { charter, deps, decisionAt } = fixture();
    const book = deterministicTargetBook(charter, deps, decisionAt, new Set());
    const b1 = shadowDecisionRecords(charter, baseContext({ lookThrough: () => [] })).find((r) => r.arm === "B1_DETERMINISTIC");
    expect(b1).toBeDefined();
    expect(b1?.targetWeights).toEqual(book.targetWeights.map((w) => ({ entityId: w.entityId, weight: w.weight.toFixed() })));
    expect(b1?.cashWeight).toBe(book.cashWeight.toFixed());
    // The fixture must actually hold something, or the gate cases below would be vacuous.
    expect((b1?.targetWeights.length ?? 0)).toBeGreaterThan(0);
  });
});

describe("shadowDecisionRecords: gate composition", () => {
  it("B0 passive clears when halt is NORMAL and takes no new risk", () => {
    const { charter } = fixture();
    const b0 = shadowDecisionRecords(charter, baseContext())[0];
    expect(b0?.arm).toBe("B0_PASSIVE");
    expect(b0?.gate.newRiskAllowed).toBe(true);
    expect(b0?.gate.haltState).toBe("NORMAL");
    expect(b0?.gate.increasedRisk).toEqual([]);
    expect(b0?.gate.blockedBy).toEqual([]);
  });

  it("B1 clears when look-through is known-clean, the list is clean, and limits are relaxed", () => {
    const { charter } = fixture();
    const b1 = shadowDecisionRecords(charter, baseContext({ lookThrough: () => [] })).find((r) => r.arm === "B1_DETERMINISTIC");
    expect(b1?.gate.newRiskAllowed).toBe(true);
    expect(b1?.gate.blockedBy).toEqual([]);
    // Deciding from empty, every held line is new risk that had to clear compliance.
    expect(b1?.gate.increasedRisk).toEqual((b1?.targetWeights ?? []).map((w) => w.entityId).sort());
  });

  it("B1 fails closed when ETF look-through has not run (the honest slice-2b default)", () => {
    const { charter } = fixture();
    // No lookThrough resolver: themeExposures is undefined, which compliance treats as an unknown state.
    const b1 = shadowDecisionRecords(charter, baseContext()).find((r) => r.arm === "B1_DETERMINISTIC");
    expect(b1?.gate.newRiskAllowed).toBe(false);
    expect(b1?.gate.blockedBy.some((r) => r.includes("UNKNOWN_LOOK_THROUGH"))).toBe(true);
  });

  it("B1 is blocked by a restricted ETF among its holdings", () => {
    const { charter, deps, decisionAt } = fixture();
    const book = deterministicTargetBook(charter, deps, decisionAt, new Set());
    const restricted = book.targetWeights[0]?.entityId;
    expect(restricted).toBeDefined();
    const list = RestrictedListConfigSchema.parse({ asOf: decisionAt.slice(0, 10), etfs: [restricted] });
    const b1 = shadowDecisionRecords(charter, baseContext({ lookThrough: () => [], restrictedList: list })).find((r) => r.arm === "B1_DETERMINISTIC");
    expect(b1?.gate.newRiskAllowed).toBe(false);
    expect(b1?.gate.blockedBy.some((r) => r.includes("RESTRICTED_ETF"))).toBe(true);
  });

  it("both arms are blocked when the halt state is not NORMAL (a stale critical input)", () => {
    const { charter } = fixture();
    const records = shadowDecisionRecords(charter, baseContext({ lookThrough: () => [], staleInputs: ["market_data"] }));
    for (const r of records) {
      expect(r.gate.newRiskAllowed).toBe(false);
      expect(r.gate.haltState).toBe("HALT_NEW_RISK");
      expect(r.gate.blockedBy.some((b) => b.includes("STALE_INPUT"))).toBe(true);
    }
  });

  it("both arms are blocked under a hold-only drawdown", () => {
    const { charter } = fixture();
    // NAV 12% below the high-water mark: past the 10% hold-only threshold.
    const drawdown = { currentWeights: new Map<string, Dec>(), portfolio: { nav: N("88"), highWaterMark: N("100"), sessionStartNav: N("100") } };
    const records = shadowDecisionRecords(charter, baseContext({ lookThrough: () => [], state: drawdown }));
    for (const r of records) {
      expect(r.gate.newRiskAllowed).toBe(false);
      expect(r.gate.haltState).toBe("HOLD_ONLY");
    }
  });

  it("B1 is blocked when a per-instrument weight cap binds (limits are wired into the gate)", () => {
    const { charter } = fixture();
    const risk = { ...relaxedRisk(), positionLimits: { ...relaxedRisk().positionLimits, maxSingleEtfWeightPct: "0.01" } };
    const b1 = shadowDecisionRecords(charter, baseContext({ lookThrough: () => [], risk })).find((r) => r.arm === "B1_DETERMINISTIC");
    expect(b1?.gate.newRiskAllowed).toBe(false);
    expect(b1?.gate.blockedBy.some((r) => r.includes("SINGLE_ETF_WEIGHT"))).toBe(true);
  });
});

describe("shadowDecisionRecords: persistence", () => {
  it("omitting the shadow book state decides from an empty book (the EMPTY_SHADOW_BOOK default)", () => {
    const { charter } = fixture();
    const withDefault = shadowDecisionRecords(charter, baseContext({ lookThrough: () => [] }));
    const withExplicit = shadowDecisionRecords(charter, baseContext({ lookThrough: () => [], state: EMPTY_SHADOW_BOOK }));
    expect(withDefault.map(sealDecision)).toEqual(withExplicit.map(sealDecision));
  });

  it("each returned record appends to the append-only ledger, idempotent per (version, arm, instant)", () => {
    const { charter } = fixture();
    const db = newDb();
    const records = shadowDecisionRecords(charter, baseContext({ lookThrough: () => [] }));
    for (const r of records) expect(appendDecisionRecord(db, r).hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Re-sealing the same arm/instant is refused rather than rewriting history.
    const b1 = records.find((r) => r.arm === "B1_DETERMINISTIC");
    expect(b1).toBeDefined();
    if (b1 !== undefined) expect(() => appendDecisionRecord(db, b1)).toThrow(DecisionAlreadySealedError);
  });
});
