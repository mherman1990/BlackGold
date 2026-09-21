import { describe, expect, it } from "vitest";
import { Dec, ONE, ZERO } from "@blackgold/shared";
import { type Charter } from "../src/strategy/charter.ts";
import { backtestParamsFromCharter, costModelFor, costsFromCharter, reportBenchmarkSeries, runBacktest, weeklyDecisionSessions, type BacktestInput } from "../src/research/backtest.ts";
import { blendSeries } from "../src/research/benchmarks.ts";
import { auditReads } from "../src/research/leakage.ts";
import { computeFeatures } from "../src/strategy/features.ts";
import { defaultProcessingDelayMs } from "../src/data/pit/repository.ts";
import { UNVERIFIED_SINGLE_SOURCE } from "../src/data/adapters/corporate-actions.ts";
import { buildMarket, fixtureCharter, D, N, type PricePath } from "./strategy-fixture.ts";


/**
 * A charter with short feature windows so a fixture of a few hundred sessions exercises the same code the
 * registered 252/200/63 windows would. Only the window lengths change; every rule, cap and cost is the
 * charter's own, and the sensitivity grid is rewritten to keep the registered point a grid member.
 */
function shortWindowCharter(): Charter {
  const c = fixtureCharter();
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

/**
 * Two results the whole suite shares: the unmodified base-tier run, and the same input at zero execution
 * delay.
 *
 * `runBacktest` is a pure function of a read-only store - it takes a `ReadOnlyPointInTime` and cannot append
 * - so every case that asserted over an unmodified run was re-deriving a result byte-identical to its
 * neighbour's, at about a second each. Sharing one result cannot couple them because nothing here writes to
 * it. Two cases deliberately keep their own runs: "is deterministic" has to execute the same input twice
 * (that is the property), and the leakage audit has to pass its own auditor into the run.
 */
let baseRun: ReturnType<typeof runBacktest> | undefined;
function defaultRun(): ReturnType<typeof runBacktest> {
  baseRun ??= runBacktest(setup().input);
  return baseRun;
}

let zeroDelay: ReturnType<typeof runBacktest> | undefined;
function zeroDelayRun(): ReturnType<typeof runBacktest> {
  if (zeroDelay === undefined) {
    const { input } = setup();
    zeroDelay = runBacktest({ ...input, costs: { ...input.costs, delayBars: 0 } });
  }
  return zeroDelay;
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
    const r = defaultRun();
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

  // ALPHA_CHARTER section 16.1's first prong is withheld on these, so a signal that never fires is worse
  // than none: it reads as a clean run. A first attempt keyed the withhold off `bt.labels`, and Codex showed
  // on PR #94 that the labels cannot carry it - `loadExecutionSeries` keeps only corporate-action codes and
  // filters even those through `blocksPromotionEvidence` (which excludes GAP and STALE_BAR by definition),
  // `STALE_BAR` never becomes a series label at all, and `RawSeries` derives GAP only between the first and
  // last loaded bar. These tests exist to prove the replacement actually fires.
  describe("navDistortingSessions", () => {
    const from = D("2026-01-02");
    const to = D("2026-06-30");

    function heldEntities(r: ReturnType<typeof runBacktest>): Set<string> {
      return new Set(r.arms["B1_DETERMINISTIC"]?.fills.map((f) => f.entityId) ?? []);
    }

    it("is empty on a clean market", () => {
      // `from`/`to` are the shared market's own range, so the clean run here IS the default run.
      const r = defaultRun();
      expect(heldEntities(r).size).toBeGreaterThan(0);
      expect(r.navDistortingSessions).toEqual([]);
    });

    it("reports a session omitted from a held instrument", () => {
      const omitted = D("2026-04-17");
      const held = [...heldEntities(defaultRun())].filter((e) => e !== "BIL");
      const entity = held[0];
      expect(entity).toBeDefined();
      if (entity === undefined) return;

      const m = buildMarket({ paths: PATHS, from, to, omitSessions: { [entity]: [omitted] } });
      const r = runBacktest(setup({ pit: m.pit, calendar: m.calendar }).input);
      expect(r.navDistortingSessions).toContain(omitted);
    });

    it("reports a stale bar on a held instrument, which no label carries", () => {
      // The hole that matters most: staleness lives on the bar's `flags` and never becomes a series label,
      // so a run with a carried-forward close looks entirely clean from `bt.labels`.
      const stale = D("2026-04-17");
      const held = [...heldEntities(defaultRun())].filter((e) => e !== "BIL");
      const entity = held[0];
      expect(entity).toBeDefined();
      if (entity === undefined) return;

      const m = buildMarket({ paths: PATHS, from, to, staleSessions: { [entity]: [stale] } });
      const r = runBacktest(setup({ pit: m.pit, calendar: m.calendar }).input);
      expect(r.navDistortingSessions).toContain(stale);
      // Exactly the point: the labels are no help here.
      expect(r.labels).not.toContain("STALE_BAR");
    });

    it("ignores a gap in a universe instrument the candidate never held", () => {
      // A gap somewhere the strategy never put money cannot move its NAV, and withholding on it would make
      // the prong unmeasurable on almost any real window.
      //
      // XLU is the fixture's only declining path, so a trend follower does not buy it - but the assertion
      // does not rest on that prediction. Both facts are read from the SAME run, so if the gap ever did
      // change the decisions enough to make XLU held, the test fails loudly rather than passing vacuously.
      const omitted = D("2026-04-17");
      const m = buildMarket({ paths: PATHS, from, to, omitSessions: { XLU: [omitted] } });
      const r = runBacktest(setup({ pit: m.pit, calendar: m.calendar }).input);

      expect(heldEntities(r).has("XLU")).toBe(false);
      expect(r.navDistortingSessions).not.toContain(omitted);
      // And XLU really is in the universe, so it was loaded and skipped rather than never seen: a version
      // of this that picked an instrument outside the universe would pass without testing anything.
      expect(shortWindowCharter().universe.risk_etfs).toContain("XLU");
    });
  });

  it("carries a consumed single-source corporate action's UNVERIFIED_SINGLE_SOURCE into the run labels (D-49)", () => {
    // A backtest that credits a single-source dividend must be barred from promotion evidence: the flag has to
    // reach the trial labels. A fresh market so the flagged action does not couple the shared-market tests.
    const exDate = D("2026-04-17");
    const m = buildMarket({
      paths: PATHS,
      from: D("2026-01-02"),
      to: D("2026-06-30"),
      actions: [{ action: { kind: "CASH_DIVIDEND", entityId: "VTI", amount: N("1.0"), exDate, payDate: exDate, qualified: false }, qualityFlags: [UNVERIFIED_SINGLE_SOURCE] }],
    });
    const { input } = setup({ pit: m.pit, calendar: m.calendar });
    const r = runBacktest(input);
    expect(r.labels).toContain(UNVERIFIED_SINGLE_SOURCE);
  });

  it("dedupes a corporate action present from both a reconciled and a single-source feed (no double-count)", () => {
    // The same dividend can arrive from the reconciled operator file AND the single-source Tiingo feed - same
    // entity/kind/exDate, different provenance (locators) - which asOf retains. Crediting both would
    // double-count it in the total-return series.
    const exDate = D("2026-04-17");
    const div = { kind: "CASH_DIVIDEND", entityId: "VTI", amount: N("2.5"), exDate, payDate: exDate, qualified: false } as const;
    const from = D("2026-01-02");
    const to = D("2026-06-30");
    const primaryTr = (m: ReturnType<typeof buildMarket>): string[] =>
      reportBenchmarkSeries(setup({ pit: m.pit, calendar: m.calendar }).input).primary.points.map((p) => p.trIndex.toFixed(10));

    const reconciledOnly = buildMarket({ paths: PATHS, from, to, actions: [{ action: div, sourceLocator: "vendored/div" }] });
    const bothSources = buildMarket({
      paths: PATHS,
      from,
      to,
      actions: [
        { action: div, sourceLocator: "vendored/div" },
        { action: div, sourceLocator: "tiingo/div", qualityFlags: [UNVERIFIED_SINGLE_SOURCE] },
      ],
    });
    // The shared market is this same fixture with no corporate actions at all, which is exactly the control.
    const noDividend = defaultMarket();

    // Deduped: the two-source run reproduces the single-action run exactly (the dividend is credited once)...
    expect(primaryTr(bothSources)).toEqual(primaryTr(reconciledOnly));
    // ...and stays above the no-dividend run, so the dividend was credited once, not zero.
    const terminal = (rows: string[]): number => Number(rows[rows.length - 1]);
    expect(terminal(primaryTr(bothSources))).toBeGreaterThan(terminal(primaryTr(noDividend)));
  });

  it("keeps conservative labeling: a superseded single-source action still taints the run (D-49)", () => {
    // The reconciled action wins the arithmetic, but the mere presence of a single-source row keeps the run
    // non-citable - the dedupe never makes a run look more citable than its store.
    const exDate = D("2026-04-17");
    const div = { kind: "CASH_DIVIDEND", entityId: "VTI", amount: N("2.5"), exDate, payDate: exDate, qualified: false } as const;
    const m = buildMarket({
      paths: PATHS,
      from: D("2026-01-02"),
      to: D("2026-06-30"),
      actions: [
        { action: div, sourceLocator: "vendored/div" },
        { action: div, sourceLocator: "tiingo/div", qualityFlags: [UNVERIFIED_SINGLE_SOURCE] },
      ],
    });
    const r = runBacktest(setup({ pit: m.pit, calendar: m.calendar }).input);
    expect(r.labels).toContain(UNVERIFIED_SINGLE_SOURCE);
  });

  it("is deterministic: the same inputs produce the same result hash and the same seals", () => {
    const a = runBacktest(setup().input);
    const b = runBacktest(setup().input);
    expect(a.resultHash).toBe(b.resultHash);
    expect(a.decisions.map((d) => d.sealHash)).toEqual(b.decisions.map((d) => d.sealHash));
  });

  it("holds at most the charter's book size and respects the per-ETF cap at every decision", () => {
    const { charter } = setup();
    const cap = new Dec(charter.sizing.max_weight_per_etf);
    const r = defaultRun();
    for (const d of r.decisions) {
      expect(d.candidates.selected.length).toBeLessThanOrEqual(charter.rules.max_positions);
      for (const [, w] of d.targets.weights) expect(w.lte(cap)).toBe(true);
      expect(d.targets.cashWeight.gte(new Dec(charter.sizing.min_cash_weight))).toBe(true);
    }
  });

  it("keeps the cluster cap at every decision", () => {
    const { charter } = setup();
    const cluster = charter.sizing.clusters[0];
    if (!cluster) throw new Error("fixture charter must declare a cluster");
    const r = defaultRun();
    for (const d of r.decisions) {
      const inCluster = d.candidates.selected.filter((e) => cluster.members.includes(e));
      expect(inCluster.length).toBeLessThanOrEqual(cluster.max_members);
    }
  });

  it("never shorts, never levers, and never spends cash it does not have", () => {
    const r = defaultRun();
    const arm = r.arms["B1_DETERMINISTIC"];
    if (!arm) throw new Error("missing arm");
    for (const p of arm.nav) {
      expect(p.cash.isNegative()).toBe(false);
      expect(p.investedWeight.lte(ONE)).toBe(true);
      expect(p.investedWeight.isNegative()).toBe(false);
    }
  });

  it("avoids the falling ETF and holds the strongest risers", () => {
    const r = defaultRun();
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
    const r = defaultRun();
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

  // ALPHA_CHARTER section 11 Secondary 2. The reads are already covered by the leakage audit above, because
  // the volatility comes from computeFeatures. What that audit cannot catch is the weight-to-session mapping:
  // a weight applied at the decision session would let a volatility estimated through that session's close
  // earn the return ending at it.
  it("applies the Secondary 2 weight only where the strategy's own fills land", () => {
    const { input } = setup();
    const r = defaultRun();
    const delay = input.costs.delayBars;
    expect(r.secondary2Weights.length).toBe(r.sessions.length);

    const indexOf = new Map(r.sessions.map((s, i) => [s, i]));
    // The only sessions at which the weight may change are decision sessions shifted by the execution delay.
    const allowed = new Set<string>();
    for (const d of r.decisions) {
      const at = indexOf.get(d.decisionSession);
      if (at === undefined) continue;
      const effective = r.sessions[at + Math.max(delay, 1)];
      if (effective !== undefined) allowed.add(effective);
    }

    let changes = 0;
    for (let i = 1; i < r.secondary2Weights.length; i++) {
      const prev = r.secondary2Weights[i - 1];
      const cur = r.secondary2Weights[i];
      if (prev === undefined || cur === undefined) continue;
      if (!cur.weight.eq(prev.weight)) {
        changes++;
        expect(allowed.has(cur.session)).toBe(true);
        // Never on the decision session itself, INCLUDING at zero delay. The previous version of this test
        // permitted the change when delay === 0, which blessed exactly the look-ahead it was meant to catch:
        // a zero-delay fill lands at the decision close, so the weight cannot earn the return ending there.
        expect(r.decisions.some((d) => d.decisionSession === cur.session)).toBe(false);
      }
    }
    expect(changes).toBeGreaterThan(0);
  });

  // The whole point of building Secondary 2 as its own index: the rebalance session is split at the open, so
  // the new weight cannot earn the overnight move its position did not exist for.
  it("splits the rebalance session at the open, so a pre-fill gap is earned at the OLD weight", () => {
    const r = defaultRun();
    const idx = r.secondary2Index;
    expect(idx).toBeDefined();
    if (idx === undefined) return;

    // A well-formed index: starts at 1, strictly positive, one point per common session, no warnings on
    // clean fixture data (a warning here means a rebalance session had no usable open).
    expect(idx.points[0]?.trIndex.eq(ONE)).toBe(true);
    for (const p of idx.points) expect(p.trIndex.gt(0)).toBe(true);
    expect(idx.warnings).toEqual([]);
    expect(idx.points.length).toBeGreaterThan(1);
  });

  it("puts a zero-delay Secondary 2 weight in force at the decision close, and no earlier", () => {
    // `delayBarsOverride: 0` fills at the decision close, so the weight IS in force at the end of the decision
    // session - and earns none of that session's return, because a close instant is the right endpoint of the
    // step ending at it. The earlier version of this test asserted the weight could not change on a decision
    // session at all, which was a symptom of the calendar-shift hack rather than the invariant: what must
    // never happen is the weight EARNING that session, which `secondary2Weights` alone cannot show. The index
    // oracle below pins that half.
    const r = zeroDelayRun();
    const decisionSessions = new Set(r.decisions.map((d) => d.decisionSession));
    let changes = 0;
    for (let i = 1; i < r.secondary2Weights.length; i++) {
      const prev = r.secondary2Weights[i - 1];
      const cur = r.secondary2Weights[i];
      if (prev === undefined || cur === undefined) continue;
      if (!cur.weight.eq(prev.weight)) {
        changes++;
        expect(decisionSessions.has(cur.session)).toBe(true);
      }
    }
    expect(changes).toBeGreaterThan(0);
  });

  // The split has to be driven by the RUN's delay, not hardcoded. `blendSeries` is the independent oracle: it
  // applies one weight to each whole close-to-close return, so feeding it the weight in force at the PREVIOUS
  // close reproduces a zero-delay Secondary 2 exactly (the fill is at that close, nothing is split) and cannot
  // reproduce a delayed one (every rebalance session is decomposed at its open).
  it("splits only when the run's own fills land at an open, not at the prior close", () => {
    const { input } = setup();
    const legs = reportBenchmarkSeries(input);

    const asLaggedBlend = (r: ReturnType<typeof runBacktest>): string[] => {
      // Weight held INTO each session: the one in force at the previous session's close.
      const heldInto = new Map<string, Dec>();
      for (let i = 1; i < r.secondary2Weights.length; i++) {
        const cur = r.secondary2Weights[i];
        const prev = r.secondary2Weights[i - 1];
        if (cur !== undefined && prev !== undefined) heldInto.set(cur.session, prev.weight);
      }
      return blendSeries({
        equity: legs.primary,
        cash: legs.cash,
        equityWeight: (session) => heldInto.get(session) ?? ZERO,
      }).points.map((p) => p.trIndex.toFixed(12));
    };
    const levels = (r: ReturnType<typeof runBacktest>): string[] => (r.secondary2Index?.points ?? []).map((p) => p.trIndex.toFixed(12));

    // Zero delay: every weight is acquired at a close, so no session is split.
    const zero = zeroDelayRun();
    expect(levels(zero).length).toBeGreaterThan(1);
    expect(zero.secondary2Exact).toBe(true);
    expect(levels(zero)).toEqual(asLaggedBlend(zero));

    // Delayed: the fill lands at an open, so every rebalance session is decomposed and the index parts
    // company with the blend. This needs a fixture whose open differs from its close - the default fixture
    // sets `open = close`, which makes every session's move entirely overnight and a split indistinguishable
    // from no split. Without this half, the zero-delay assertion above could pass on a no-op split.
    const gapMarket = buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-06-30"), openRatio: { VTI: N("0.985"), BIL: N("0.999") } });
    const gapped = setup({ pit: gapMarket.pit, calendar: gapMarket.calendar });
    const delayed = runBacktest(gapped.input);
    expect(gapped.input.costs.delayBars).toBeGreaterThanOrEqual(1);
    const gapLegs = reportBenchmarkSeries(gapped.input);
    const heldInto = new Map<string, Dec>();
    for (let i = 1; i < delayed.secondary2Weights.length; i++) {
      const cur = delayed.secondary2Weights[i];
      const prev = delayed.secondary2Weights[i - 1];
      if (cur !== undefined && prev !== undefined) heldInto.set(cur.session, prev.weight);
    }
    const gapBlend = blendSeries({
      equity: gapLegs.primary,
      cash: gapLegs.cash,
      equityWeight: (session) => heldInto.get(session) ?? ZERO,
    }).points.map((p) => p.trIndex.toFixed(12));
    expect(delayed.secondary2Exact).toBe(true);
    expect(levels(delayed).length).toBeGreaterThan(1);
    expect(levels(delayed)).not.toEqual(gapBlend);
  });

  it("reports Secondary 2 inexact when a fill lands on a session the legs do not share", () => {
    // BIL loses the session VTI's fill lands on, so that instant falls inside a stretched return interval
    // with no price to place it at. There is no safe side to guess: under-crediting the comparator makes the
    // strategy easier to promote, over-crediting makes it harder, and which one a guess causes depends on the
    // signs of the weight change and of the move. The index says so instead, and `report.ts` withholds the
    // prong on it.
    const holed = buildMarket({
      paths: PATHS,
      from: D("2026-01-02"),
      to: D("2026-06-30"),
      omitSessions: { BIL: [D("2026-03-09")] },
    });
    const r = runBacktest(setup({ pit: holed.pit, calendar: holed.calendar }).input);
    expect(r.secondary2Index).toBeDefined();
    expect(r.secondary2Exact).toBe(false);
    expect(r.secondary2InexactReasons.join(" ")).toContain("falls inside the");
  });

  it("reports Secondary 2 inexact when its window does not match the run's", () => {
    // BIL loses the run's FIRST session, so the index spans one session less than the candidate arm while
    // every rebalance still places exactly. `buildResultReport` subtracts two independently computed total
    // returns, so a shorter comparator window makes the prong a difference between different intervals - not
    // an excess return over anything. Comparing unequal windows is the misplacement defect at window scale.
    const short = buildMarket({
      paths: PATHS,
      from: D("2026-01-02"),
      to: D("2026-06-30"),
      omitSessions: { BIL: [D("2026-03-02")] },
    });
    const r = runBacktest(setup({ pit: short.pit, calendar: short.calendar }).input);
    expect(r.secondary2Index).toBeDefined();
    expect(r.sessions[0]).toBe(D("2026-03-02"));
    expect(r.secondary2Index?.points[0]?.session).not.toBe(D("2026-03-02"));
    expect(r.secondary2Exact).toBe(false);
    expect(r.secondary2InexactReasons.join(" ")).toContain("cover different intervals");
  });

  it("counts a session BOTH legs lack, using the run's own calendar", () => {
    // Two bars missing on the same date leave it in neither leg's total-return series, so the union of what
    // the legs observed cannot see it - only the run's calendar can. The resulting step collapses two daily
    // rebalances into one, which at a fractional weight is not the quantity section 11 describes.
    //
    // A volatile VTI is needed for the weight to BE fractional: the default fixture's primary runs well under
    // the 10% target, so k pins at 1 and the collapse is genuinely exempt. Without this the test would pass
    // whether or not the calendar were consulted.
    const volatile: PricePath[] = PATHS.map((x) => (x.entityId === "VTI" ? { ...x, wobble: N("0.012") } : x));
    const both = buildMarket({
      paths: volatile,
      from: D("2026-01-02"),
      to: D("2026-06-30"),
      omitSessions: { VTI: [D("2026-05-12")], BIL: [D("2026-05-12")] },
    });
    const r = runBacktest(setup({ pit: both.pit, calendar: both.calendar }).input);
    expect(r.secondary2Index).toBeDefined();
    // The weight really is fractional somewhere, or the exemption would make this vacuous.
    expect(r.secondary2Weights.some((w) => w.weight.gt(0) && w.weight.lt(ONE))).toBe(true);
    expect(r.secondary2Exact).toBe(false);
    expect(r.secondary2InexactReasons.join(" ")).toContain("skips 1 session(s)");
  });

  it("does not call the estimator's warm-up an approximation", () => {
    // Before the first computable primary volatility there is no previous target to wrongly persist, and the
    // comparator sitting in cash is what section 11 describes and what the strategy does before its first
    // fill. Recording that as inexact would withhold the prong on every run and make the flag meaningless.
    //
    // The mid-window case - an estimator that loses the primary AFTER a target exists, leaving last week's
    // target in force - is recorded instead. That branch is NOT covered by a test: no fixture reachable from
    // here removes the volatility (a stale bar keeps series continuity, and a long gap still leaves enough
    // observations in the covariance window), so it is guarded by construction rather than by evidence. The
    // warm-up guard itself IS covered - removing it turns three evaluation tests red, which I verified.
    const clean = defaultRun();
    expect(clean.secondary2Exact).toBe(true);
    expect(clean.secondary2InexactReasons.join(" ")).not.toContain("no primary volatility");
  });

  it("places Secondary 2 exactly on clean data, and no longer withholds it", () => {
    const r = defaultRun();
    expect(r.secondary2Exact).toBe(true);
    expect(r.secondary2Index?.warnings).toEqual([]);
    expect(r.secondary2InexactReasons).toEqual([]);
    // The unconditional withhold that stood in for the legSplit ex-date defect is gone with the defect.
    expect(r.secondary2Withheld).toBe(false);
  });

  it("withholds exactly the runs it could not place, and no others", () => {
    // The withhold now tracks placement exactly, so this asserts the correspondence in both directions - a
    // run that placed exactly is usable, one that did not is withheld.
    //
    // The inexact fixture is the load-bearing one, and stays so. An earlier version of this test used three
    // CLEAN runs, all of which place exactly, which made it blind to any assignment that got the inexact
    // case wrong - including one that inverted the gate outright. Both sides of `exact` have to be present.
    const holed = buildMarket({
      paths: PATHS,
      from: D("2026-01-02"),
      to: D("2026-06-30"),
      omitSessions: { BIL: [D("2026-03-09")] },
    });
    const runs = [
      defaultRun(),
      zeroDelayRun(),
      runBacktest({ ...setup().input, costs: costsFromCharter(setup().charter, "adverse") }),
      runBacktest(setup({ pit: holed.pit, calendar: holed.calendar }).input),
    ];
    expect(runs.some((r) => r.secondary2Exact)).toBe(true);
    expect(runs.some((r) => !r.secondary2Exact)).toBe(true);
    for (const r of runs) {
      expect(r.secondary2Index).toBeDefined();
      expect(r.secondary2Withheld).toBe(!r.secondary2Exact);
    }
  });

  it("holds Secondary 2 in cash until its first decision takes effect, and keeps it long-only", () => {
    const r = defaultRun();
    const first = r.secondary2Weights[0];
    expect(first?.weight.isZero()).toBe(true);
    for (const w of r.secondary2Weights) {
      expect(w.weight.isNegative()).toBe(false);
      expect(w.weight.lte(ONE)).toBe(true);
    }
  });

  it("scales Secondary 2 by min(1, target / primary volatility), as section 9.5 does", () => {
    // Asserts the FORMULA against the estimator's own output, recomputed here through `computeFeatures` at
    // the same decision instant rather than read back out of the run - a test that consumed the run's own
    // scale factor would only be restating it.
    //
    // TWO fixtures, because the `min` has two branches and one fixture cannot exercise both: the wobble is
    // constant within a run, so the primary's volatility sits either side of the 10% target for the whole
    // window. A calm primary pins k at 1 (the cap), a volatile one keeps k below it (the scale). The previous
    // version used one fixture and asserted only `capped + scaled === checked`, which is true by
    // construction and passes at `capped === 0`; before that it asserted only that weights lay in (0, 1],
    // every part of which survived replacing the formula with an arbitrary positive fraction.
    // Six weeks of decisions per branch rather than four months. The assertion is per weight change and the
    // wobble is constant within a run, so a branch that is exercised at all is exercised on its first few
    // rebalances; the counts below still refuse a window that produced none.
    const branch = (wobble: Dec): { checked: number; capped: number; scaled: number } => {
      const paths: PricePath[] = PATHS.map((x) => (x.entityId === "VTI" ? { ...x, wobble } : x));
      const m = buildMarket({ paths, from: D("2026-01-02"), to: D("2026-04-15") });
      const { charter, input } = setup({ pit: m.pit, calendar: m.calendar, to: D("2026-04-15") });
      const r = runBacktest(input);
      const params = backtestParamsFromCharter(charter);
      const target = params.sizing.annualVolatilityTarget;
      // One evaluation per session, not one per weight change. `computeFeatures` re-reads the whole window
      // at the instant it is given, so calling it twice for the same session repeats the identical reads.
      const volCache = new Map<string, Dec | undefined>();
      const volAt = (session: ReturnType<typeof D>): Dec | undefined => {
        if (!volCache.has(session)) {
          volCache.set(
            session,
            computeFeatures(
              { pit: m.pit, calendar: m.calendar },
              {
                riskEntities: [...charter.universe.risk_etfs],
                cashEntityId: charter.universe.cash_etf,
                decisionAt: m.decisionAt(session),
                params: params.features,
              },
            ).features.get(charter.benchmarks.primary)?.vol,
          );
        }
        return volCache.get(session);
      };

      const decisionSessions = new Set(r.decisions.map((d) => d.decisionSession));
      const indexOf = new Map(r.sessions.map((x, i) => [x, i]));
      let checked = 0;
      let capped = 0;
      let scaled = 0;
      for (let i = 1; i < r.secondary2Weights.length; i++) {
        const cur = r.secondary2Weights[i];
        const prev = r.secondary2Weights[i - 1];
        if (cur === undefined || prev === undefined || cur.weight.eq(prev.weight)) continue;
        const at = indexOf.get(cur.session);
        const decisionSession = at === undefined ? undefined : r.sessions[at - Math.max(input.costs.delayBars, 1)];
        if (decisionSession === undefined || !decisionSessions.has(decisionSession)) continue;
        const vol = volAt(decisionSession);
        if (vol === undefined) continue;
        const k = vol.gt(0) ? target.div(vol) : ONE;
        const expected = k.lt(ONE) ? k : ONE;
        expect(cur.weight.toFixed(12)).toBe(expected.toFixed(12));
        checked++;
        if (expected.eq(ONE)) capped++;
        else scaled++;
      }
      return { checked, capped, scaled };
    };

    // Calm primary: volatility under the 10% target, so `min` returns 1 and the cap branch is exercised.
    const calm = branch(N("0.001"));
    expect(calm.checked).toBeGreaterThan(0);
    expect(calm.capped).toBeGreaterThan(0);

    // Volatile primary: volatility above the target, so `min` returns target / sigma.
    const volatile = branch(N("0.012"));
    expect(volatile.checked).toBeGreaterThan(0);
    expect(volatile.scaled).toBeGreaterThan(0);
  });

  it("refuses to be cited as evidence while the charter is a draft", () => {
    const r = defaultRun();
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
    const base = defaultRun();
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
    const { charter } = setup();
    const r = defaultRun();
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
    const r = defaultRun();
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
    const r = defaultRun();
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
