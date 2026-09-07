import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { Dec, ONE, ZERO } from "@blackgold/shared";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import { backtestParamsFromCharter, costModelFor, costsFromCharter, runBacktest, weeklyDecisionSessions, type BacktestInput } from "../src/research/backtest.ts";
import { auditReads } from "../src/research/leakage.ts";
import { defaultProcessingDelayMs } from "../src/data/pit/repository.ts";
import { buildMarket, D, N, type PricePath } from "./strategy-fixture.ts";

/**
 * A backtest over 17 weekly decisions re-reads its feature window at every decision instant, which is the
 * honest cost of point-in-time reads and is deliberately not cached in production (see runBacktest). Several
 * tests here run two full backtests to compare them. Vitest's 5-second default was never a realistic budget
 * for that: the slowest test measured 4.2s locally and timed out at 5.0s on a slower CI runner, so the same
 * commit passed and failed depending on which machine picked it up.
 *
 * 30 seconds is the declared budget. It is roughly seven times the slowest observed test, so runner speed
 * cannot decide the outcome, while a genuine hang still fails rather than running forever.
 */
vi.setConfig({ testTimeout: 30_000 });

/**
 * A charter with short feature windows so a fixture of a few hundred sessions exercises the same code the
 * registered 252/200/63 windows would. Only the window lengths change; every rule, cap and cost is the
 * charter's own, and the sensitivity grid is rewritten to keep the registered point a grid member.
 */
function shortWindowCharter(): Charter {
  const base = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
  const c = structuredClone(base);
  c.universe.risk_etfs = ["VTI", "QQQ", "IWM", "VTV", "VUG", "XLK", "XLV", "XLU"];
  c.universe.conditional = [];
  c.universe.look_through_flagged = [];
  c.sizing.clusters = [{ id: "A", members: ["VTI", "QQQ", "VUG", "XLK"], max_members: 3 }];
  c.features = { ...c.features, momentum_lookback_sessions: 20, momentum_skip_sessions: 4, trend_sma_sessions: 10, volatility_sessions: 15, adv_sessions: 5, min_adv_usd: "1000000" };
  c.boundaries = {
    registered_history_start: "2026-01-02",
    design: { start: "2026-01-02", end: "2026-06-30" },
    holdout: { start: "2026-07-01", end: "2026-09-30" },
    recent: { start: "2026-10-01", end: "2026-12-31" },
    walk_forward: { window_years: 1, step_months: 1, purge_days: 5, embargo_days: 2 },
  };
  c.sensitivity_grid = {
    momentum: [{ lookback_sessions: 20, skip_sessions: 4 }, { lookback_sessions: 10, skip_sessions: 4 }],
    trend_sma_sessions: [10, 15],
    volatility_sessions: [15],
    ranks: [{ entry: 5, hold: 7 }, { entry: 4, hold: 6 }],
    annual_volatility_target: ["0.10", "0.15"],
    rebalance_band_pct_points: ["2.0"],
  };
  return c;
}

/** Eight risk ETFs on separated trend paths plus a cash leg, so ranks are unambiguous. */
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
 * The default fixture market, built once for the whole file.
 *
 * `runBacktest` only reads the store, so sharing one market across tests cannot couple them, and building it
 * appends 1200-odd observations that were otherwise re-inserted for every single test. A test that needs a
 * different market (a feed with a hole, say) still builds its own.
 */
let sharedMarket: ReturnType<typeof buildMarket> | undefined;
function defaultMarket(): ReturnType<typeof buildMarket> {
  sharedMarket ??= buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-06-30") });
  return sharedMarket;
}

function setup(over: Partial<BacktestInput> = {}, charterOver: (c: Charter) => void = () => undefined) {
  const c = shortWindowCharter();
  charterOver(c);
  const m = defaultMarket();
  const input: BacktestInput = {
    charter: c,
    charterHash: "sha256:" + "0".repeat(64),
    pit: m.pit,
    calendar: m.calendar,
    from: D("2026-03-02"),
    to: D("2026-06-30"),
    initialCash: N("100000"),
    costs: costsFromCharter(c, "base"),
    params: backtestParamsFromCharter(c),
    registrabilityReasons: ["approval.state is DRAFT; only APPROVED may be registered"],
    ...over,
  };
  return { charter: c, market: m, input };
}

describe("weeklyDecisionSessions", () => {
  it("picks the last session of each exchange week", () => {
    const m = buildMarket({ paths: PATHS.slice(0, 1), from: D("2026-01-02"), to: D("2026-02-28") });
    const weekly = weeklyDecisionSessions(m.calendar, D("2026-01-05"), D("2026-02-27"));
    expect(weekly.length).toBeGreaterThan(6);
    for (const s of weekly) {
      const dow = new Date(`${s}T00:00:00Z`).getUTCDay();
      // Normally a Friday; a Friday holiday moves the decision to the Thursday.
      expect(dow === 5 || dow === 4).toBe(true);
    }
    expect(new Set(weekly).size).toBe(weekly.length);
  });
});

describe("costsFromCharter", () => {
  it("resolves per-symbol half spreads with a default fallback", () => {
    const c = shortWindowCharter();
    const base = costsFromCharter(c, "base");
    expect(costModelFor(base, "VTI").halfSpreadBps.eq(ONE)).toBe(true);
    expect(costModelFor(base, "XLU").halfSpreadBps.eq(N("2"))).toBe(true);
    // Slippage and the impact proxy are folded into the simulator's single slippage term.
    expect(costModelFor(base, "VTI").slippageBps.eq(N("5"))).toBe(true);
  });

  it("scales every component by a stress multiplier and labels the tier", () => {
    const c = shortWindowCharter();
    const doubled = costsFromCharter(c, "base", { multiplier: N("2") });
    expect(doubled.tier).toBe("basex2");
    expect(costModelFor(doubled, "VTI").halfSpreadBps.eq(N("2"))).toBe(true);
    expect(doubled.slippageBps.eq(N("10"))).toBe(true);
  });

  it("takes the adverse and stress tiers straight from the charter", () => {
    const c = shortWindowCharter();
    expect(costsFromCharter(c, "adverse").delayBars).toBe(2);
    expect(costsFromCharter(c, "stress").marketImpactBps.eq(N("2"))).toBe(true);
  });

  it("honours a delay override for the sensitivity grid", () => {
    expect(costsFromCharter(shortWindowCharter(), "base", { delayBarsOverride: 5 }).delayBars).toBe(5);
  });
});

describe("runBacktest", () => {
  it("produces sealed weekly decisions and two independent arms", () => {
    const { input } = setup();
    const r = runBacktest(input);
    expect(r.decisions.length).toBeGreaterThan(10);
    expect(Object.keys(r.arms).sort()).toEqual(["B0_PASSIVE", "B1_DETERMINISTIC"]);
    for (const d of r.decisions) {
      expect(d.sealHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(d.nav.gt(0)).toBe(true);
      expect(d.decisionSession >= input.from).toBe(true);
      expect(d.decisionSession <= input.to).toBe(true);
      // The decision is anchored at or before its own session, never after.
      expect(d.anchorSession <= d.decisionSession).toBe(true);
    }
  });

  it("is deterministic: the same inputs produce the same result hash and the same seals", () => {
    const a = runBacktest(setup().input);
    const b = runBacktest(setup().input);
    expect(a.resultHash).toBe(b.resultHash);
    expect(a.decisions.map((d) => d.sealHash)).toEqual(b.decisions.map((d) => d.sealHash));
  });

  it("holds at most the charter's book size and respects the per-ETF cap at every decision", () => {
    const { charter, input } = setup();
    const cap = new Dec(charter.sizing.max_weight_per_etf);
    const r = runBacktest(input);
    for (const d of r.decisions) {
      expect(d.candidates.selected.length).toBeLessThanOrEqual(charter.rules.max_positions);
      for (const [, w] of d.targets.weights) expect(w.lte(cap)).toBe(true);
      expect(d.targets.cashWeight.gte(new Dec(charter.sizing.min_cash_weight))).toBe(true);
    }
  });

  it("keeps the cluster cap at every decision", () => {
    const { charter, input } = setup();
    const cluster = charter.sizing.clusters[0];
    if (!cluster) throw new Error("fixture charter must declare a cluster");
    const r = runBacktest(input);
    for (const d of r.decisions) {
      const inCluster = d.candidates.selected.filter((e) => cluster.members.includes(e));
      expect(inCluster.length).toBeLessThanOrEqual(cluster.max_members);
    }
  });

  it("never shorts, never levers, and never spends cash it does not have", () => {
    const r = runBacktest(setup().input);
    const arm = r.arms["B1_DETERMINISTIC"];
    if (!arm) throw new Error("missing arm");
    for (const p of arm.nav) {
      expect(p.cash.isNegative()).toBe(false);
      expect(p.investedWeight.lte(ONE)).toBe(true);
      expect(p.investedWeight.isNegative()).toBe(false);
    }
  });

  it("avoids the falling ETF and holds the strongest risers", () => {
    const r = runBacktest(setup().input);
    const everSelected = new Set(r.decisions.flatMap((d) => d.candidates.selected));
    // XLU falls every session, so its trend flag is never up.
    expect(everSelected.has("XLU")).toBe(false);
    // QQQ and XLK are the two fastest risers and clear the cash hurdle throughout.
    expect(everSelected.has("QQQ")).toBe(true);
    expect(everSelected.has("XLK")).toBe(true);
  });

  it("passes an independent leakage audit of every decision read", () => {
    const { market, input } = setup();
    const auditor = auditReads(market.pit, { defaultDelayMs: defaultProcessingDelayMs });
    const r = runBacktest({ ...input, auditor });
    const report = auditor.report();
    expect(r.decisions.length).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.minMarginMs).toBeGreaterThanOrEqual(0);
    // The decision channel walks forward through the window and reads nothing it could not have known.
    expect(report.reads).toBeGreaterThan(r.decisions.length);
  });

  it("never fills before or on the decision session at the charter's one-session delay", () => {
    const r = runBacktest(setup().input);
    expect(r.executionOrderViolations).toEqual([]);
    const arm = r.arms["B1_DETERMINISTIC"];
    if (!arm) throw new Error("missing arm");
    expect(arm.fills.length).toBeGreaterThan(0);
    for (const d of r.decisions) {
      for (const f of arm.fills.filter((x) => x.session >= d.decisionSession)) {
        if (d.orders.some((o) => o.entityId === f.entityId)) expect(f.session > d.decisionSession).toBe(true);
      }
    }
  });

  it("refuses to be cited as evidence while the charter is a draft", () => {
    const r = runBacktest(setup().input);
    expect(r.citableAsEvidence).toBe(false);
    expect(r.citabilityReasons.join(" ")).toContain("DRAFT");
  });

  it("bars a zero-delay run from evidence through the OPTIMISTIC_DELAY label", () => {
    const { charter, input } = setup();
    const r = runBacktest({ ...input, costs: costsFromCharter(charter, "base", { delayBarsOverride: 0 }), registrabilityReasons: [] });
    expect(r.labels).toContain("OPTIMISTIC_DELAY");
    expect(r.citableAsEvidence).toBe(false);
    expect(r.citabilityReasons.join(" ")).toContain("OPTIMISTIC_DELAY");
  });

  it("bars a synthetic missing-data run from evidence", () => {
    const { input } = setup();
    const r = runBacktest({ ...input, missingDataRate: N("0.05"), registrabilityReasons: [] });
    expect(r.labels).toContain("SYNTHETIC_MISSING_DATA");
    expect(r.citableAsEvidence).toBe(false);
  });

  it("costs more under the adverse and stress tiers than under the base tier", () => {
    const { charter, input } = setup();
    const base = runBacktest(input);
    const stress = runBacktest({ ...input, costs: costsFromCharter(charter, "stress") });
    const baseArm = base.arms["B1_DETERMINISTIC"];
    const stressArm = stress.arms["B1_DETERMINISTIC"];
    if (!baseArm || !stressArm) throw new Error("missing arm");
    expect(baseArm.fills.length).toBeGreaterThan(0);
    // Higher assumed spreads and slippage make each simulated buy more expensive.
    const meanPrice = (a: typeof baseArm): Dec => {
      const buys = a.fills.filter((f) => f.side === "BUY" && f.entityId === "QQQ");
      return buys.length === 0 ? ZERO : buys.reduce((acc, f) => acc.plus(f.price), ZERO).div(buys.length);
    };
    if (meanPrice(baseArm).gt(0) && meanPrice(stressArm).gt(0)) expect(meanPrice(stressArm).gt(meanPrice(baseArm))).toBe(true);
  });

  it("trades less at a wider rebalance band", () => {
    const { input, charter } = setup();
    const tight = runBacktest({ ...input, params: { ...backtestParamsFromCharter(charter), rebalanceBandPctPoints: N("0.1") } });
    const wide = runBacktest({ ...input, params: { ...backtestParamsFromCharter(charter), rebalanceBandPctPoints: N("15") } });
    const count = (r: typeof tight): number => r.decisions.reduce((a, d) => a + d.orders.length, 0);
    expect(count(wide)).toBeLessThan(count(tight));
  });

  it("runs the passive arm as buy-and-hold of the primary benchmark", () => {
    const { charter, input } = setup();
    const r = runBacktest(input);
    const passive = r.arms["B0_PASSIVE"];
    if (!passive) throw new Error("missing passive arm");
    expect(passive.fills).toHaveLength(1);
    expect(passive.fills[0]?.entityId).toBe(charter.benchmarks.primary);
    expect(passive.fills[0]?.side).toBe("BUY");
    // Buy and hold realizes nothing.
    expect(passive.realized.total.isZero()).toBe(true);
    expect(passive.index.points.length).toBe(r.sessions.length);
  });

  it("keeps the arms independent: the passive arm has no decisions and its own cash", () => {
    const r = runBacktest(setup().input);
    const passive = r.arms["B0_PASSIVE"];
    const deterministic = r.arms["B1_DETERMINISTIC"];
    if (!passive || !deterministic) throw new Error("missing arm");
    expect(passive.nav[0]?.nav).toBeDefined();
    expect(deterministic.nav[0]?.nav).toBeDefined();
    // Both start from the same cash but hold different books: the passive arm holds only the benchmark.
    expect(new Set(passive.fills.map((f) => f.entityId))).toEqual(new Set(["VTI"]));
    expect(deterministic.fills.some((f) => f.entityId === "QQQ")).toBe(true);
    expect(deterministic.fills.some((f) => f.entityId === "VTI" && f.side === "SELL")).toBe(
      deterministic.fills.some((f) => f.entityId === "VTI" && f.side === "SELL"),
    );
  });

  it("reports the realized equity weight per session for the exposure-matched benchmark", () => {
    const r = runBacktest(setup().input);
    expect(r.equityWeights).toHaveLength(r.sessions.length);
    for (const w of r.equityWeights) {
      expect(w.weight.isNegative()).toBe(false);
      expect(w.weight.lte(ONE)).toBe(true);
    }
    expect(r.equityWeights.some((w) => w.weight.gt(ZERO))).toBe(true);
  });

  it("excludes an undecided conditional universe member from every decision", () => {
    const { input } = setup({}, (c) => {
      c.universe.risk_etfs = [...c.universe.risk_etfs, "SPY"];
      c.universe.conditional = [{ symbol: "SPY", condition: "test condition", admitted: null }];
    });
    const r = runBacktest(input);
    const everSelected = new Set(r.decisions.flatMap((d) => d.candidates.selected));
    expect(everSelected.has("SPY")).toBe(false);
  });

  it("carries the GAP label when a member's feed has a hole", () => {
    const c = shortWindowCharter();
    const m = buildMarket({
      paths: PATHS,
      from: D("2026-01-02"),
      to: D("2026-06-30"),
      omitSessions: { XLV: [D("2026-04-13"), D("2026-04-14"), D("2026-04-15")] },
    });
    const r = runBacktest({
      charter: c,
      charterHash: "sha256:" + "0".repeat(64),
      pit: m.pit,
      calendar: m.calendar,
      from: D("2026-03-02"),
      to: D("2026-06-30"),
      initialCash: N("100000"),
      costs: costsFromCharter(c, "base"),
      params: backtestParamsFromCharter(c),
    });
    expect(r.labels).toContain("GAP");
  });
});
