import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { Dec, ONE, ZERO, isoDate, type IsoDate } from "@blackgold/shared";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import { TR_ADJUSTMENT_VERSION, type TRPoint, type TRSeries } from "../src/market/series.ts";
import { armMetrics, buildResultReport, REPORT_VERSION, taxScenarios } from "../src/research/report.ts";
import { backtestParamsFromCharter, costsFromCharter, runBacktest } from "../src/research/backtest.ts";
import { buildMarket, D, N, type PricePath } from "./strategy-fixture.ts";

/**
 * Building a report runs a full backtest first, so these tests carry the same cost as the backtest suite and
 * the same reason for an explicit budget: vitest's 5-second default is not a realistic ceiling for a
 * multi-decision backtest plus a bootstrap, and leaving it there lets runner speed decide the outcome.
 */
vi.setConfig({ testTimeout: 30_000 });

function charter(): Charter {
  return loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
}

function series(entityId: string, sessions: readonly IsoDate[], growth: Dec): TRSeries {
  const points: TRPoint[] = [];
  let index = ONE;
  sessions.forEach((session, i) => {
    if (i > 0) index = index.times(growth);
    points.push({ session, trIndex: index, adjClose: index, distribution: ZERO, terminal: false });
  });
  return { entityId, points, adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings: [] };
}

function businessSessions(count: number, start = "2026-01-05"): IsoDate[] {
  const out: IsoDate[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(isoDate(d.toISOString().slice(0, 10)));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("armMetrics", () => {
  const sessions = businessSessions(300);
  const cash = series("BIL", sessions, N("1.00008"));
  const primary = series("VTI", sessions, N("1.0004"));

  it("computes the protocol's headline numbers for a rising series", () => {
    const index = series("ARM", sessions, N("1.0008"));
    const m = armMetrics({ arm: "B1_DETERMINISTIC", index, cash, primary });
    expect(m.totalReturn.gt(0)).toBe(true);
    expect(m.cagr.gt(0)).toBe(true);
    // A monotone series has no drawdown and therefore no Calmar ratio.
    expect(m.maxDrawdown.isZero()).toBe(true);
    expect(m.calmar).toBeUndefined();
    expect(m.annualizedVolatility).toBeCloseTo(0, 10);
    expect(m.sessions).toBe(sessions.length);
  });

  it("reports a drawdown, Calmar, and the worst 21-session window for a falling stretch", () => {
    const points: TRPoint[] = [];
    let level = ONE;
    sessions.forEach((session, i) => {
      level = i < 150 ? level.times(N("1.001")) : level.times(N("0.998"));
      points.push({ session, trIndex: level, adjClose: level, distribution: ZERO, terminal: false });
    });
    const m = armMetrics({ arm: "A", index: { entityId: "A", points, adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings: [] }, cash, primary });
    expect(m.maxDrawdown.isNegative()).toBe(true);
    expect(m.calmar).toBeDefined();
    expect(m.worst21Session?.isNegative()).toBe(true);
    expect(m.tailLosses.p05).toBeLessThan(0);
  });

  it("derives exposure, cash share and turnover from the NAV path", () => {
    const index = series("ARM", sessions, N("1.0004"));
    const nav = sessions.map((session, i) => ({ session, nav: N("100000"), cash: N("20000"), investedWeight: i < 100 ? N("0.3") : N("0.9") }));
    const m = armMetrics({ arm: "A", index, cash, primary, nav, tradedNotional: N("500000"), fills: 12 });
    expect(m.averageEquityWeight?.gt(N("0.5"))).toBe(true);
    // The first 100 of 300 sessions sat under half invested.
    expect(m.monthsMostlyCash?.minus(ONE.div(3)).abs().lt(N("0.01"))).toBe(true);
    expect(m.annualTurnover?.gt(0)).toBe(true);
    expect(m.fills).toBe(12);
  });

  it("degrades safely on a series too short to measure", () => {
    const m = armMetrics({ arm: "A", index: { entityId: "A", points: [], adjustmentVersion: TR_ADJUSTMENT_VERSION, warnings: [] }, cash, primary });
    expect(m.totalReturn.isZero()).toBe(true);
    expect(m.cagr.isZero()).toBe(true);
    expect(m.sharpeVsCash).toBe(0);
    expect(m.sessions).toBe(0);
  });
});

describe("taxScenarios", () => {
  it("charges tax only in the taxable scenario and states the rates it used", () => {
    const results = taxScenarios({
      realized: { shortTerm: N("10000"), longTerm: N("5000"), total: N("15000") },
      totalReturn: N("0.20"),
      initialCash: N("100000"),
      rates: { shortTerm: N("0.32"), longTerm: N("0.15") },
      scenarios: ["pre_tax", "taxable_short_long_split", "tax_deferred"],
    });
    const pre = results.find((r) => r.scenario === "pre_tax");
    const taxable = results.find((r) => r.scenario === "taxable_short_long_split");
    const deferred = results.find((r) => r.scenario === "tax_deferred");
    expect(pre?.taxCharged.isZero()).toBe(true);
    expect(deferred?.taxCharged.isZero()).toBe(true);
    // 10000 x 0.32 + 5000 x 0.15 = 3950.
    expect(taxable?.taxCharged.eq(N("3950"))).toBe(true);
    expect(taxable?.afterTaxReturn.eq(N("0.1605"))).toBe(true);
    expect(taxable?.shortTermRate.eq(N("0.32"))).toBe(true);
  });

  it("carries the sleeve-only wash-sale disclaimer on every scenario", () => {
    const results = taxScenarios({
      realized: { shortTerm: ZERO, longTerm: ZERO, total: ZERO },
      totalReturn: ZERO,
      initialCash: N("1000"),
      rates: { shortTerm: N("0.32"), longTerm: N("0.15") },
      scenarios: ["pre_tax", "taxable_short_long_split"],
    });
    for (const r of results) {
      expect(r.disclaimer).toContain("wash-sale");
      expect(r.disclaimer).toContain("never autonomously tax-loss harvests");
    }
  });

  it("credits a realized loss as a tax reduction rather than ignoring it", () => {
    const results = taxScenarios({
      realized: { shortTerm: N("-4000"), longTerm: ZERO, total: N("-4000") },
      totalReturn: N("-0.04"),
      initialCash: N("100000"),
      rates: { shortTerm: N("0.32"), longTerm: N("0.15") },
      scenarios: ["taxable_short_long_split"],
    });
    expect(results[0]?.taxCharged.isNegative()).toBe(true);
    expect(results[0]?.afterTaxReturn.gt(N("-0.04"))).toBe(true);
  });
});

describe("buildResultReport", () => {
  const PATHS: PricePath[] = [
    { entityId: "VTI", start: N("200"), perSession: N("1.0010"), volumeShares: 4_000_000n, wobble: N("0.003") },
    { entityId: "QQQ", start: N("400"), perSession: N("1.0018"), volumeShares: 5_000_000n, wobble: N("0.005") },
    { entityId: "IWM", start: N("180"), perSession: N("1.0006"), volumeShares: 3_000_000n, wobble: N("0.004") },
    { entityId: "XLV", start: N("140"), perSession: N("1.0008"), volumeShares: 2_500_000n, wobble: N("0.003") },
    { entityId: "XLU", start: N("70"), perSession: N("0.9994"), volumeShares: 2_000_000n, wobble: N("0.002") },
    { entityId: "BIL", start: N("91"), perSession: N("1.00008"), volumeShares: 900_000n },
  ];

  function shortCharter(): Charter {
    const c = structuredClone(charter());
    c.universe.risk_etfs = ["VTI", "QQQ", "IWM", "XLV", "XLU"];
    c.universe.conditional = [];
    c.universe.look_through_flagged = [];
    c.sizing.clusters = [{ id: "A", members: ["VTI", "QQQ"], max_members: 1 }];
    c.features = { ...c.features, momentum_lookback_sessions: 20, momentum_skip_sessions: 4, trend_sma_sessions: 10, volatility_sessions: 15, adv_sessions: 5, min_adv_usd: "1000000" };
    c.rules = { ...c.rules, entry_rank: 3, hold_rank: 4, max_positions: 3, max_new_positions_per_decision: 3 };
    c.sizing.max_weight_per_etf = "0.40";
    c.sensitivity_grid = {
      momentum: [{ lookback_sessions: 20, skip_sessions: 4 }],
      trend_sma_sessions: [10],
      volatility_sessions: [15],
      ranks: [{ entry: 3, hold: 4 }],
      annual_volatility_target: ["0.10"],
      rebalance_band_pct_points: ["2.0"],
    };
    return c;
  }

  // Read-only across tests, so one market serves the whole suite (see the backtest suite for the reasoning).
  let sharedMarket: ReturnType<typeof buildMarket> | undefined;

  function run() {
    const c = shortCharter();
    sharedMarket ??= buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-06-30") });
    const m = sharedMarket;
    const bt = runBacktest({
      charter: c,
      charterHash: `sha256:${"0".repeat(64)}`,
      pit: m.pit,
      calendar: m.calendar,
      from: D("2026-03-02"),
      to: D("2026-06-30"),
      initialCash: N("100000"),
      costs: costsFromCharter(c, "base"),
      params: backtestParamsFromCharter(c),
      registrabilityReasons: ["approval.state is DRAFT; only APPROVED may be registered"],
    });
    const sessions = bt.sessions;
    return {
      charter: c,
      backtest: bt,
      primary: series("VTI", sessions, N("1.0010")),
      cash: series("BIL", sessions, N("1.00008")),
      trialLedgerCount: 1,
      bootstrapResamples: 200,
      bootstrapSeed: 5,
    };
  }

  it("reports both arms, the charter's benchmarks, and the primary metric with its interval", () => {
    const r = buildResultReport(run());
    expect(r.version).toBe(REPORT_VERSION);
    expect(r.reportId).toMatch(/^res_20260630_[0-9a-f]{8}$/);
    expect(r.arms.map((a) => a.arm).sort()).toEqual(["B0_PASSIVE", "B1_DETERMINISTIC"]);
    const names = r.benchmarks.map((b) => b.arm);
    expect(names).toContain("VTI_TR");
    expect(names).toContain("EXPOSURE_MATCHED");
    expect(names).toContain("VOLATILITY_CONTROLLED_PRIMARY");
    // The point estimate never travels without its interval.
    expect(r.primaryMetric.interval.lower).toBeLessThanOrEqual(r.primaryMetric.interval.upper);
    expect(r.primaryMetric.interval.meanBlockSessions).toBe(21);
    expect(r.primaryMetric.interval.confidence).toBe(0.9);
    expect(r.primaryMetric.threshold).toBe(0.1);
  });

  it("shows the passive baseline on the same page as the candidate", () => {
    const r = buildResultReport(run());
    const candidate = r.arms.find((a) => a.arm === "B1_DETERMINISTIC");
    const passive = r.arms.find((a) => a.arm === "B0_PASSIVE");
    expect(candidate).toBeDefined();
    expect(passive).toBeDefined();
    expect(passive?.fills).toBe(1);
    expect(candidate?.fills).toBeGreaterThan(1);
  });

  it("carries the charter's reasons it may not work verbatim", () => {
    const args = run();
    const r = buildResultReport(args);
    expect(r.reasonsItMayNotWork).toEqual(args.charter.reasons_it_may_not_work);
    expect(r.reasonsItMayNotWork.length).toBeGreaterThan(5);
  });

  it("marks the report uncitable while the charter is a draft, and says why", () => {
    const r = buildResultReport(run());
    expect(r.citableAsEvidence).toBe(false);
    expect(r.citabilityReasons.join(" ")).toContain("DRAFT");
  });

  it("reports every declared tax scenario with its stated rates", () => {
    const args = run();
    const r = buildResultReport(args);
    expect(r.taxScenarios.map((t) => t.scenario)).toEqual(args.charter.tax_scenarios);
  });

  it("reports the trial ledger count and the independent-decision count", () => {
    const r = buildResultReport({ ...run(), trialLedgerCount: 72 });
    expect(r.trialLedgerCount).toBe(72);
    expect(r.independentDecisions).toBeGreaterThan(0);
    expect(r.decisions).toBeGreaterThan(0);
  });

  it("hashes deterministically for the same inputs", () => {
    const a = buildResultReport(run());
    const b = buildResultReport(run());
    expect(a.reportHash).toBe(b.reportHash);
    expect(a.reportId).toBe(b.reportId);
  });

  it("refuses to build without the deterministic arm", () => {
    const args = run();
    const stripped = { ...args, backtest: { ...args.backtest, arms: {} } };
    expect(() => buildResultReport(stripped)).toThrow(RangeError);
  });
});
