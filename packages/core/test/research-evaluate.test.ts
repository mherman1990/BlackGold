import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadCharterFile, registrabilityReasons, type Charter } from "../src/strategy/charter.ts";
import { runEvaluation } from "../src/research/evaluate.ts";
import { SplitRangeError } from "../src/research/walkforward.ts";
import { UNVERIFIED_SINGLE_SOURCE } from "../src/data/adapters/corporate-actions.ts";
import { buildMarket, D, N, type PricePath } from "./strategy-fixture.ts";

/**
 * A charter with short feature windows and design/holdout/recent windows that fall inside a one-year fixture,
 * so `runEvaluation` exercises the real split → backtest → report path on a few hundred synthetic sessions.
 * Only lengths change; every rule, cap and cost stays the charter's own, and the grid keeps the registered
 * point a member (mirrors the backtest suite's short-window charter).
 */
function evalCharter(mut: (c: Charter) => void = () => undefined): Charter {
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
  mut(c);
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

// One clean market over the whole year covers the design, holdout and recent windows. runEvaluation only reads
// the store, so a shared market cannot couple tests; a test that needs flagged data builds its own.
let sharedMarket: ReturnType<typeof buildMarket> | undefined;
function cleanMarket(): ReturnType<typeof buildMarket> {
  sharedMarket ??= buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-12-31") });
  return sharedMarket;
}

function evaluate(c: Charter, market: ReturnType<typeof buildMarket>) {
  return runEvaluation({
    charter: c,
    charterHash: "sha256:" + "0".repeat(64),
    registrabilityReasons: registrabilityReasons(c),
    pit: market.pit,
    calendar: market.calendar,
  });
}

describe("runEvaluation", () => {
  it("evaluates the design and recent splits and never the sealed holdout", () => {
    const r = evaluate(evalCharter(), cleanMarket());
    expect(r.evaluationVersion).toBe(1);
    // Design and recent are in-window; the 1-year walk-forward window yields no rolling split here.
    const kinds = r.splits.map((s) => s.kind);
    expect(kinds).toContain("DESIGN");
    expect(kinds).toContain("RECENT");
    expect(kinds).not.toContain("HOLDOUT");
    // No evaluated split may fall inside the sealed holdout window.
    for (const s of r.splits) {
      expect(s.evaluation.start > "2026-09-30" || s.evaluation.end < "2026-07-01").toBe(true);
      expect(s.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(s.resultHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(s.reportId).toMatch(/^res_\d{8}_[0-9a-f]{8}$/);
    }
    expect(r.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.barsSourceId).toBe("tiingo.eod.bars.1d");
  });

  it("is deterministic: the same charter and store hash to the same report", () => {
    const m = cleanMarket();
    const a = evaluate(evalCharter(), m);
    const b = evaluate(evalCharter(), m);
    expect(a.reportHash).toBe(b.reportHash);
    expect(a.splits.map((s) => s.reportHash)).toEqual(b.splits.map((s) => s.reportHash));
    expect(a.splits.map((s) => s.resultHash)).toEqual(b.splits.map((s) => s.resultHash));
  });

  it("an approved charter over clean data is registrable and citable as evidence", () => {
    const r = evaluate(evalCharter(), cleanMarket());
    expect(r.registrable).toBe(true);
    expect(r.promotionBlockingCodes).toEqual([]);
    expect(r.citableAsEvidence).toBe(true);
  });

  it("bars a run over single-source data from being cited as evidence, even under an approved charter (D-49)", () => {
    const exDate = D("2026-02-13");
    const flagged = buildMarket({
      paths: PATHS,
      from: D("2026-01-02"),
      to: D("2026-12-31"),
      actions: [{ action: { kind: "CASH_DIVIDEND", entityId: "VTI", amount: N("1.0"), exDate, payDate: exDate, qualified: false }, qualityFlags: [UNVERIFIED_SINGLE_SOURCE] }],
    });
    const r = evaluate(evalCharter(), flagged);
    expect(r.registrable).toBe(true); // the charter is fine; the data is not
    expect(r.promotionBlockingCodes).toContain(UNVERIFIED_SINGLE_SOURCE);
    expect(r.citableAsEvidence).toBe(false);
    const design = r.splits.find((s) => s.kind === "DESIGN");
    expect(design?.promotionBlockingCodes).toContain(UNVERIFIED_SINGLE_SOURCE);
    expect(design?.citableAsEvidence).toBe(false);
    expect(design?.labels).toContain(UNVERIFIED_SINGLE_SOURCE);
  });

  it("marks a draft charter unregistrable and uncitable, and says why", () => {
    const draft = evalCharter((c) => {
      c.approval = { ...c.approval, state: "DRAFT" };
    });
    const r = evaluate(draft, cleanMarket());
    expect(r.registrable).toBe(false);
    expect(r.registrabilityReasons.length).toBeGreaterThan(0);
    expect(r.citableAsEvidence).toBe(false);
    for (const s of r.splits) expect(s.citableAsEvidence).toBe(false);
  });

  it("refuses to evaluate when a split would overlap the sealed holdout", () => {
    // A holdout that overlaps the design window must abort the whole run, never silently evaluate into it.
    const bad = evalCharter((c) => {
      c.boundaries = { ...c.boundaries, holdout: { start: "2026-03-01", end: "2026-05-31" } };
    });
    expect(() => evaluate(bad, cleanMarket())).toThrow(SplitRangeError);
  });

  it("runs only the requested split kinds when a --split filter is given", () => {
    const c = evalCharter();
    const m = cleanMarket();
    const full = evaluate(c, m);
    expect(full.splitKinds).toContain("DESIGN");
    expect(full.splitKinds).toContain("RECENT");

    const recentOnly = runEvaluation({
      charter: c,
      charterHash: "sha256:" + "0".repeat(64),
      registrabilityReasons: registrabilityReasons(c),
      pit: m.pit,
      calendar: m.calendar,
      splitKinds: ["RECENT"],
    });
    expect(recentOnly.splitKinds).toEqual(["RECENT"]);
    expect(recentOnly.splits.every((s) => s.kind === "RECENT")).toBe(true);
    expect(recentOnly.splits.length).toBeLessThan(full.splits.length);
    // Narrowing scope changes the run, so the envelope hash differs from the full run.
    expect(recentOnly.reportHash).not.toBe(full.reportHash);
  });

  it("emits progress around each split and at the start and end", () => {
    const c = evalCharter();
    const events: string[] = [];
    const r = runEvaluation({
      charter: c,
      charterHash: "sha256:" + "0".repeat(64),
      registrabilityReasons: registrabilityReasons(c),
      pit: cleanMarket().pit,
      calendar: cleanMarket().calendar,
      onProgress: (e) => events.push(e.phase),
    });
    const n = r.splits.length;
    expect(events[0]).toBe("start");
    expect(events[events.length - 1]).toBe("done");
    expect(events.filter((p) => p === "split-start").length).toBe(n);
    expect(events.filter((p) => p === "split-done").length).toBe(n);
  });
});
