/**
 * Temporal fixtures from docs/DATA_PROVENANCE_SPEC.md section 11 that involve prices, positions, and universes:
 *   split, dividend, delisting, survivorship label, stale bar, symbol change.
 * Position-protection effects (PROTECTION_PENDING after a split) belong to the gateway and are covered in Phase 6.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dec, isoDate, sha256Hex, utc, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import {
  EntityMap,
  ExperimentRegistry,
  Ledger,
  NyseCalendar,
  PointInTimeRepository,
  Portfolio,
  PromotionEvidenceRefusedError,
  RawSeries,
  TotalReturnSeries,
  UniverseStore,
  dailyBarTimes,
  labelsFor,
  openCoreDb,
  rawBarToValue,
  simulateFill,
  type CorporateAction,
  type ExperimentDefinitionInput,
  type RawBar,
} from "@blackgold/core";

const cal = new NyseCalendar();
const T = (s: string): UtcInstant => utc(s);
const SHA = `sha256:${sha256Hex("charter")}`;

function rig(): { db: Db; pit: PointInTimeRepository } {
  const dir = mkdtempSync(join(tmpdir(), "bg-mkt-"));
  const db = openCoreDb({ dbPath: join(dir, "m.sqlite") }).db;
  return { db, pit: new PointInTimeRepository(db, { clock: () => Date.parse("2026-12-31T00:00:00Z") }) };
}

/** Consecutive NYSE sessions starting 2026-09-08 (Tue). */
const SESSIONS: IsoDate[] = cal.sessionDates(isoDate("2026-09-08"), isoDate("2026-09-18"));

function bar(symbol: string, session: IsoDate, close: string, volume = 1_000_000n): RawBar {
  const c = dec(close);
  return { symbol, session, open: c, high: c.plus("0.5"), low: c.minus("0.5"), close: c, volume, venue: "iex" };
}

function storeBars(pit: PointInTimeRepository, bars: RawBar[], flags: (b: RawBar, i: number) => string[] = () => []): void {
  bars.forEach((b, i) => {
    const t = dailyBarTimes(b.session, cal);
    pit.append({
      sourceId: "alpaca.iex.bars.1d",
      sourceLocator: `alpaca/bars/1d/${b.symbol}/${b.session}${flags(b, i).includes("STALE_BAR") ? "#repeat" : ""}`,
      entityId: b.symbol,
      observedAt: t.observedAt,
      availableAt: t.availableAt,
      ingestedAt: T("2026-12-31T00:00:00Z"),
      rawContentHash: `sha256:${sha256Hex(`${JSON.stringify(rawBarToValue(b))}#${String(i)}`)}`,
      adapterVersion: "1.0.0",
      parserVersion: "1.0.0",
      value: rawBarToValue(b),
      qualityFlags: [...t.flags, ...flags(b, i)],
    });
  });
}

describe("Fixture: split", () => {
  it("raw fills unchanged, held quantity multiplied, total-return series continuous", () => {
    const closes = ["400", "404", "408", "102", "103", "104"]; // 4:1 split effective on the 4th session
    const bars = closes.map((c, i) => bar("SPLT", SESSIONS[i] ?? isoDate("2026-09-08"), c));
    const exDate = SESSIONS[3] ?? isoDate("2026-09-11");
    const actions: CorporateAction[] = [{ kind: "SPLIT", entityId: "SPLT", ratio: dec(4), exDate }];
    const tr = TotalReturnSeries.build(bars, actions, "SPLT");
    const idx = tr.points.map((p) => p.trIndex.div(tr.points[0]?.trIndex ?? dec(1)).toFixed(6));
    expect(idx).toEqual(["1.000000", "1.010000", "1.020000", "1.020000", "1.030000", "1.040000"]);
    // Raw series is untouched: the split day prints 102, a quarter of the prior close.
    expect(bars[3]?.close.toFixed()).toBe("102");

    const p = new Portfolio(dec("50000"));
    p.applyFill({ entityId: "SPLT", side: "BUY", quantity: dec(100), price: dec("400"), fees: dec(0), session: SESSIONS[0] ?? isoDate("2026-09-08") });
    expect(p.quantity("SPLT").toFixed()).toBe("100");
    p.applySplit("SPLT", dec(4));
    expect(p.quantity("SPLT").toFixed()).toBe("400");
    expect(p.position("SPLT")?.lots[0]?.costPerShare.toFixed()).toBe("100");
    const nav = p.nav(new Map([["SPLT", dec("104")]]));
    // 10000 cash + 400 x 104 = 51600 = 50000 + 100 x 400 x 0.04
    expect(nav.toFixed()).toBe("51600");
    expect(nav.minus("50000").div("40000").toFixed(6)).toBe(tr.points.at(-1)?.trIndex.div(tr.points[0]?.trIndex ?? dec(1)).minus(1).toFixed(6));
  });
});

describe("Fixture: dividend", () => {
  it("TR reinvests at the ex-date close; cash credits on the pay-date; raw series unchanged", () => {
    const closes = ["100", "100", "100", "100", "100", "100", "100", "100"];
    const bars = closes.map((c, i) => bar("DIVI", SESSIONS[i] ?? isoDate("2026-09-08"), c));
    const exDate = SESSIONS[1] ?? isoDate("2026-09-09");
    const payDate = SESSIONS[6] ?? isoDate("2026-09-16");
    const actions: CorporateAction[] = [{ kind: "CASH_DIVIDEND", entityId: "DIVI", amount: dec("2"), exDate, payDate, qualified: true }];
    const tr = TotalReturnSeries.build(bars, actions, "DIVI");
    const rel = tr.points.map((p) => p.trIndex.div(tr.points[0]?.trIndex ?? dec(1)).toFixed(4));
    expect(rel[0]).toBe("1.0000");
    expect(rel[1]).toBe("1.0200"); // reinvested on the ex-date
    expect(rel.at(-1)).toBe("1.0200");
    expect(bars.every((b) => b.close.eq(100))).toBe(true);

    const p = new Portfolio(dec("10000"));
    p.applyFill({ entityId: "DIVI", side: "BUY", quantity: dec(100), price: dec("100"), fees: dec(0), session: SESSIONS[0] ?? isoDate("2026-09-08") });
    expect(p.cash.toFixed()).toBe("0");
    // Nothing on the ex-date; cash arrives on the pay-date.
    p.applyDividend({ entityId: "DIVI", amountPerShare: dec("2"), payDate });
    expect(p.dividends()[0]?.payDate).toBe(payDate);
    expect(p.cash.toFixed()).toBe("200");
    expect(p.nav(new Map([["DIVI", dec("100")]])).toFixed()).toBe("10200");
  });
});

describe("Fixture: delisting", () => {
  it("realizes the full loss, keeps the name in the historical snapshot, and is not SURVIVORSHIP_BIASED", () => {
    const { pit } = rig();
    const universe = new UniverseStore(pit);
    const eff = T("2026-09-08T00:00:00Z");
    universe.addSnapshot({ universeId: "smallcaps_pit", effectiveAt: eff, availableAt: eff, members: ["GONE", "STAY"], survivorshipFree: true, source: "test:pit-membership" });
    const closes = ["10", "9", "6", "3"];
    const bars = closes.map((c, i) => bar("GONE", SESSIONS[i] ?? isoDate("2026-09-08"), c));
    const lastTrade = SESSIONS[3] ?? isoDate("2026-09-11");
    const actions: CorporateAction[] = [{ kind: "DELISTING", entityId: "GONE", lastTradeDate: lastTrade, reason: "bankruptcy", finalPrice: null }];
    const tr = TotalReturnSeries.build(bars, actions, "GONE");
    expect(tr.points.at(-1)?.trIndex.isZero()).toBe(true);

    const p = new Portfolio(dec("1000"));
    p.applyFill({ entityId: "GONE", side: "BUY", quantity: dec(100), price: dec("10"), fees: dec(0), session: SESSIONS[0] ?? isoDate("2026-09-08") });
    const gains = p.applyDelisting("GONE", null, lastTrade);
    expect(gains.reduce((acc, g) => acc.plus(g.gain), dec(0)).toFixed()).toBe("-1000");
    expect(p.quantity("GONE").isZero()).toBe(true);
    expect(p.nav(new Map()).toFixed()).toBe("0");

    // The historical snapshot still lists the delisted name and carries no survivorship label.
    const m = universe.membersAsOf("smallcaps_pit", T("2026-10-01T00:00:00Z"));
    expect(m?.members).toEqual(["GONE", "STAY"]);
    expect(m?.labels).toEqual([]);
    expect(labelsFor({ survivorshipFree: true })).toEqual([]);
  });
});

describe("Fixture: survivorship label", () => {
  it("a universe seeded from a current constituent list is SURVIVORSHIP_BIASED and the registry refuses promotion evidence", () => {
    const { db, pit } = rig();
    const universe = new UniverseStore(pit);
    const eff = T("2020-01-02T00:00:00Z");
    universe.addSnapshot({ universeId: "russell_today_backcast", effectiveAt: eff, availableAt: eff, members: ["AAA", "BBB"], survivorshipFree: false, source: "current constituents projected backwards" });
    const m = universe.membersAsOf("russell_today_backcast", T("2020-06-01T00:00:00Z"));
    expect(m?.labels).toContain("SURVIVORSHIP_BIASED");

    const ledger = new Ledger(db);
    const snap = pit.createSnapshot("universe", "biased");
    const reg = new ExperimentRegistry(db, pit, ledger);
    const def: ExperimentDefinitionInput = {
      charter: { strategy_id: "form4-insider-cluster", charter_version: "0.1.0", charter_hash: SHA },
      code: { repo: "mherman1990/BlackGold", commit: "4f7a2c9e1b0d" },
      data: { snapshots: [{ dataset: "universe", snapshot_id: snap.snapshotId }], processing_delay_ms: 15 * 60_000 },
      versions: { features: 1, strategy_rules: 1, portfolio_construction: 1, risk_policy: 1, cost_model: 1 },
      arms: ["B0_PASSIVE", "B1_DETERMINISTIC"],
      search_space: { grid: { lookback_days: [126] }, sampling: "full_grid", trial_count: 1 },
      boundaries: {
        train: { start: "2010-01-04", end: "2016-12-30" },
        validation: { start: "2017-01-03", end: "2019-12-31" },
        walk_forward: { window_years: 3, step_months: 12, purge_days: 21, embargo_days: 5 },
        holdout: { start: "2020-01-02", end: "2025-12-31", opened: false },
      },
      metrics: { primary: "net_information_ratio_vs_primary_benchmark", secondary: ["max_drawdown"] },
      costs: {
        base: { commission_bps: "0", half_spread_bps: "2", slippage_bps: "3", delay_bars: 1 },
        adverse: { commission_bps: "0", half_spread_bps: "5", slippage_bps: "8", delay_bars: 1 },
        stress_multipliers: ["1.0", "2.0"],
        delay_sensitivity_bars: [0, 1, 2],
        missing_data_rates: ["0.00"],
      },
      benchmarks: { primary: "VTI_TR", exposure_matched: { equity: "VTI_TR", cash: "BIL_TR" }, secondary: ["SPY_TR"] },
      pass_fail: { primary_condition: "B1 minus B0 net IR > 0.10", robustness_conditions: ["sign unchanged under 2x costs"], minimum_independent_decisions: 60 },
      tax_scenarios: ["pre_tax"],
    };
    const rec = reg.register(def, { registeredBy: "owner", labels: m?.labels ?? [] });
    expect(rec.labels).toContain("SURVIVORSHIP_BIASED");
    expect(rec.promotionEvidenceAllowed).toBe(false);
    reg.markResultsViewed(rec.experimentId, { viewedBy: "owner" });
    reg.openHoldout(rec.experimentId, { reason: "fixture", requestedBy: "owner" });
    expect(() => reg.setPromotionEvidence(rec.experimentId, true, { requestedBy: "owner" })).toThrow(PromotionEvidenceRefusedError);
  });
});

describe("Fixture: stale bar", () => {
  it("a repeated bar is STALE_BAR, untradable in simulation, and bridged in the return series", () => {
    const { pit } = rig();
    const closes = ["50", "51", "51", "53", "54"];
    const bars = closes.map((c, i) => bar("STAL", SESSIONS[i] ?? isoDate("2026-09-08"), c));
    storeBars(pit, bars, (_b, i) => (i === 2 ? ["STALE_BAR"] : []));
    const loaded = RawSeries.load({ pit, entityId: "STAL", from: SESSIONS[0] ?? isoDate("2026-09-08"), to: SESSIONS[4] ?? isoDate("2026-09-14"), decisionAt: T("2026-12-01T00:00:00Z"), calendar: cal });
    expect(loaded.bars.map((b) => b.tradable)).toEqual([true, true, false, true, true]);
    const tr = TotalReturnSeries.build(loaded.bars, [], "STAL");
    expect(tr.points.map((p) => p.session)).toEqual([SESSIONS[0], SESSIONS[1], SESSIONS[3], SESSIONS[4]]);
    // Return bridges the gap: 51 -> 53 is one step.
    expect(tr.points[2]?.trIndex.div(tr.points[1]?.trIndex ?? dec(1)).toFixed(6)).toBe(dec(53).div(51).toFixed(6));
    // A decision on session 1 with a one-bar delay lands on the stale bar: no fill there, filled on the next bar.
    const sim = simulateFill({
      intent: { entityId: "STAL", side: "BUY", quantity: dec(100) },
      bars: loaded.bars,
      decisionSession: SESSIONS[1] ?? isoDate("2026-09-09"),
      delayBars: 1,
      costs: { commissionBps: dec(0), halfSpreadBps: dec(2), slippageBps: dec(3) },
      maxParticipation: dec("0.5"),
    });
    expect(sim.skippedSessions).toEqual([SESSIONS[2]]);
    expect(sim.fills[0]?.session).toBe(SESSIONS[3]);
    expect(sim.filledQuantity.toFixed()).toBe("100");
  });
});

describe("Fixture: symbol change", () => {
  it("position continuity via entityId; restricted-list matching sees both symbols", () => {
    const { db } = rig();
    const map = new EntityMap(db);
    map.register({ symbol: "OLDC", entityId: "ENT-77", effectiveFrom: isoDate("2020-01-02"), source: "seed:test" });
    const change: CorporateAction = { kind: "SYMBOL_CHANGE", entityId: "ENT-77", oldSymbol: "OLDC", newSymbol: "NEWC", effective: isoDate("2026-09-10") };
    map.applyAction(change);
    expect(map.resolve("OLDC", isoDate("2026-09-09"))).toBe("ENT-77");
    expect(map.resolve("NEWC", isoDate("2026-09-10"))).toBe("ENT-77");
    expect(map.resolve("OLDC", isoDate("2026-09-10"))).toBeUndefined(); // UNKNOWN_ENTITY after the change
    expect(map.symbolsFor("ENT-77").sort()).toEqual(["NEWC", "OLDC"]);
    // A position keyed by entityId survives the rename.
    const p = new Portfolio(dec("10000"));
    p.applyFill({ entityId: "ENT-77", side: "BUY", quantity: dec(10), price: dec("100"), fees: dec(0), session: isoDate("2026-09-08") });
    expect(p.quantity("ENT-77").toFixed()).toBe("10");
    expect(map.symbolOn("ENT-77", isoDate("2026-09-11"))).toBe("NEWC");
  });
});
