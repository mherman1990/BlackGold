import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dec, dec, isoDate, sha256Hex, utc } from "@blackgold/shared";
import {
  NyseCalendar,
  PointInTimeRepository,
  Portfolio,
  RawSeries,
  TotalReturnSeries,
  corporateActionObservation,
  dailyBarTimes,
  logReturns,
  navReturn,
  openCoreDb,
  periodReturn,
  rawBarFromValue,
  rawBarToValue,
  simpleReturns,
  dailyNavSeries,
  type CorporateAction,
  type RawBar,
} from "../src/index.ts";

const H = `sha256:${sha256Hex("bars")}`;
const d = isoDate;

function bar(session: string, close: string, volume = 100_000n, open = close): RawBar {
  return { symbol: "TST", session: d(session), open: new Dec(open), high: new Dec(close).plus(1), low: new Dec(close).minus(1), close: new Dec(close), volume, venue: "iex" };
}

/** Sessions 2026-03-02 .. 2026-03-13 are all NYSE sessions (Good Friday 2026 is April 3). */
const SPLIT_DIV_BARS: RawBar[] = [
  bar("2026-03-02", "100"),
  bar("2026-03-03", "102"), // dividend 1 ex-date, 2.00/share, pays 03-05
  bar("2026-03-04", "104"),
  bar("2026-03-05", "102"), // pay-date; close equals the ex-date close so a pay-date reinvestment matches the TR convention
  bar("2026-03-06", "108"),
  bar("2026-03-09", "27.5"), // 4:1 split ex-date
  bar("2026-03-10", "28"), // dividend 2 ex-date, 0.25/share, pays 03-12
  bar("2026-03-11", "29"),
  bar("2026-03-12", "28"),
  bar("2026-03-13", "30"),
];
const SPLIT_DIV_ACTIONS: CorporateAction[] = [
  { kind: "CASH_DIVIDEND", entityId: "TST", amount: new Dec("2"), exDate: d("2026-03-03"), payDate: d("2026-03-05"), qualified: true },
  { kind: "SPLIT", entityId: "TST", ratio: new Dec("4"), exDate: d("2026-03-09") },
  { kind: "CASH_DIVIDEND", entityId: "TST", amount: new Dec("0.25"), exDate: d("2026-03-10"), payDate: d("2026-03-12"), qualified: true },
];

describe("TotalReturnSeries.build", () => {
  it("split divides prior prices and dividends reinvest at the ex-date close (hand-computed)", () => {
    const tr = TotalReturnSeries.build(SPLIT_DIV_BARS, SPLIT_DIV_ACTIONS);
    expect(tr.adjustmentVersion).toBe("tr-1.0.0");
    expect(tr.warnings).toEqual([]);
    expect(tr.points).toHaveLength(10);
    // Pre-split closes are divided by 4; post-split closes are unchanged.
    expect(tr.points[0]?.adjClose.toFixed()).toBe("25");
    expect(tr.points[4]?.adjClose.toFixed()).toBe("27");
    expect(tr.points[5]?.adjClose.toFixed()).toBe("27.5");
    expect(tr.points[9]?.adjClose.toFixed()).toBe("30");
    // Dividend 1 in adjusted units is 2/4 = 0.5 per adjusted share.
    expect(tr.points[1]?.distribution.toFixed()).toBe("0.5");
    expect(tr.points[6]?.distribution.toFixed()).toBe("0.25");
    // Day 1 -> 2: (102 + 2) / 100.
    expect(tr.points[1]?.trIndex.toFixed()).toBe("1.04");
    // Full path: 1.04 * (108/102) * (110/108) * (28.25/27.5) * (30/28) = 1.2344537815...
    const expected = new Dec("1.04").times("110").div("102").times("28.25").div("27.5").times("30").div("28");
    expect(tr.points[9]?.trIndex.minus(expected).abs().lt("1e-30")).toBe(true);
    expect(tr.points[9]?.trIndex.toFixed(6)).toBe("1.234454");
  });

  it("raw-fill simulation with the cash dividend ledger equals the total-return series (spec section 4 invariant)", () => {
    const tr = TotalReturnSeries.build(SPLIT_DIV_BARS, SPLIT_DIV_ACTIONS);
    const closes = new Map(SPLIT_DIV_BARS.map((b) => [b.session, b.close] as const));
    const p = new Portfolio(dec(10_000));
    p.applyFill({ entityId: "TST", side: "BUY", quantity: dec(100), price: new Dec("100"), fees: new Dec("0"), session: d("2026-03-02") });
    // Dividend 1: entitled 100 raw shares at the ex-date, cash arrives on the pay-date, reinvested at the pay-date close.
    const div1 = p.applyDividend({ entityId: "TST", amountPerShare: new Dec("2"), payDate: d("2026-03-05"), entitledQuantity: dec(100) });
    expect(div1.amount.toFixed()).toBe("200");
    p.applyFill({ entityId: "TST", side: "BUY", quantity: div1.amount.div("102"), price: new Dec("102"), fees: new Dec("0"), session: d("2026-03-05") });
    // Split: quantity x4, raw prices unchanged.
    const before = p.quantity("TST");
    p.applySplit("TST", new Dec("4"));
    expect(p.quantity("TST").eq(before.times(4))).toBe(true);
    // Dividend 2 on the post-split quantity held at the ex-date.
    const div2 = p.applyDividend({ entityId: "TST", amountPerShare: new Dec("0.25"), payDate: d("2026-03-12") });
    p.applyFill({ entityId: "TST", side: "BUY", quantity: div2.amount.div("28"), price: new Dec("28"), fees: new Dec("0"), session: d("2026-03-12") });
    expect(p.cash.isZero()).toBe(true);
    const navEnd = p.nav(new Map([["TST", closes.get(d("2026-03-13")) ?? new Dec(0)]]));
    const simReturn = navEnd.div(10_000);
    const trReturn = tr.points[9]?.trIndex ?? new Dec(0);
    expect(simReturn.div(trReturn).minus(1).abs().lt("1e-9")).toBe(true);
    // Sanity: it is a real number, not a degenerate 0 = 0.
    expect(simReturn.toFixed(6)).toBe("1.234454");
  });

  it("split-only path: NAV replay from raw fills reproduces the TR index exactly", () => {
    const bars = [bar("2026-03-02", "50"), bar("2026-03-03", "53.7"), bar("2026-03-04", "17.1"), bar("2026-03-05", "19.93"), bar("2026-03-06", "18.2")];
    const actions: CorporateAction[] = [{ kind: "SPLIT", entityId: "TST", ratio: new Dec("3"), exDate: d("2026-03-04") }];
    const tr = TotalReturnSeries.build(bars, actions);
    const closes = new Map(bars.map((b) => [b.session, new Map([["TST", b.close]])] as const));
    const { points } = dailyNavSeries({
      initialCash: dec(5_000),
      events: [
        { type: "FILL", entityId: "TST", side: "BUY", quantity: dec(100), price: new Dec("50"), fees: new Dec("0"), session: d("2026-03-02") },
        { type: "SPLIT", entityId: "TST", ratio: new Dec("3"), exDate: d("2026-03-04") },
      ],
      sessions: bars.map((b) => b.session),
      closes: (s) => closes.get(s) ?? new Map(),
    });
    for (let i = 0; i < bars.length; i++) {
      const nav = points[i]?.nav ?? new Dec(0);
      const idx = tr.points[i]?.trIndex ?? new Dec(0);
      expect(nav.div(5_000).minus(idx).abs().lt("1e-25"), bars[i]?.session).toBe(true);
    }
    expect(navReturn(points).toFixed(4)).toBe("0.0920"); // 18.2 * 3 / 50 - 1
  });

  it("spin-off credits ratio x child first close as a distribution on the ex-date", () => {
    const bars = [bar("2026-03-02", "50"), bar("2026-03-03", "48"), bar("2026-03-04", "49")];
    const actions: CorporateAction[] = [{ kind: "SPINOFF", parent: "TST", child: "KID", ratio: new Dec("0.5"), exDate: d("2026-03-03"), childFirstClose: new Dec("10") }];
    const tr = TotalReturnSeries.build(bars, actions);
    expect(tr.points[1]?.distribution.toFixed()).toBe("5");
    expect(tr.points[1]?.trIndex.toFixed()).toBe("1.06"); // (48 + 5) / 50
    expect(tr.points[2]?.trIndex.toFixed(10)).toBe(new Dec("1.06").times(49).div(48).toFixed(10));
    const unvalued = TotalReturnSeries.build(bars, [{ kind: "SPINOFF", parent: "TST", child: "KID", ratio: new Dec("0.5"), exDate: d("2026-03-03") }]);
    expect(unvalued.warnings[0]).toMatch(/childFirstClose/);
    expect(unvalued.points[1]?.trIndex.toFixed()).toBe("0.96");
  });

  it("delisting ends the series and realizes the final price (zero when none), never dropping the name", () => {
    const bars = [bar("2026-03-02", "10"), bar("2026-03-03", "8"), bar("2026-03-04", "4"), bar("2026-03-05", "3")];
    const zero = TotalReturnSeries.build(bars, [{ kind: "DELISTING", entityId: "TST", lastTradeDate: d("2026-03-04"), reason: "bankruptcy", finalPrice: null }]);
    expect(zero.points.map((p) => p.session)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]);
    expect(zero.points[3]?.terminal).toBe(true);
    expect(zero.points[3]?.trIndex.isZero()).toBe(true);
    expect(simpleReturns(zero.points).map((r) => r.value.toFixed())).toEqual(["-0.2", "-0.5", "-1"]);
    expect(() => logReturns(zero.points)).toThrow(/log return undefined/);
    const recovery = TotalReturnSeries.build(bars, [{ kind: "DELISTING", entityId: "TST", lastTradeDate: d("2026-03-04"), reason: "cash-out", finalPrice: new Dec("1") }]);
    expect(recovery.points[3]?.trIndex.toFixed()).toBe("0.1");
  });

  it("stale bars are excluded so the return bridges the gap", () => {
    const bars = [bar("2026-03-02", "10"), bar("2026-03-03", "10"), bar("2026-03-04", "12")];
    const tr = TotalReturnSeries.build(bars, [{ kind: "STALE_BAR", entityId: "TST", session: d("2026-03-03"), reason: "provider repeated prior close" }]);
    expect(tr.points.map((p) => p.session)).toEqual(["2026-03-02", "2026-03-04"]);
    expect(tr.points[1]?.trIndex.toFixed()).toBe("1.2");
    expect(periodReturn(tr.points, d("2026-03-02"), d("2026-03-04")).toFixed()).toBe("0.2");
    expect(periodReturn(tr.points, d("2026-03-03"), d("2026-03-04")).toFixed()).toBe("0.2"); // last point at or before 03-03 is 03-02
    expect(() => periodReturn(tr.points, d("2026-03-01"), d("2026-03-04"))).toThrow(/no series point/);
  });

  it("rejects duplicate sessions and round-trips the JSON bar shape", () => {
    expect(() => TotalReturnSeries.build([bar("2026-03-02", "10"), bar("2026-03-02", "11")], [])).toThrow(/duplicate session/);
    const b = bar("2026-03-02", "123.45", 42n, "120");
    const round = rawBarFromValue(JSON.parse(JSON.stringify(rawBarToValue(b))));
    expect(round).toEqual(b);
    expect(() => rawBarFromValue({ ...rawBarToValue(b), close: "abc" })).toThrow(/decimal string/);
    expect(() => rawBarFromValue({ ...rawBarToValue(b), volume: "-1" })).toThrow(/volume/);
  });
});

describe("RawSeries.load", () => {
  function setup(): { pit: PointInTimeRepository; cal: NyseCalendar } {
    const dir = mkdtempSync(join(tmpdir(), "bg-series-"));
    const pit = new PointInTimeRepository(openCoreDb({ dbPath: join(dir, "s.sqlite") }).db, { clock: () => Date.parse("2026-09-08T00:00:00Z") });
    const cal = new NyseCalendar();
    const ingestedAt = utc("2026-09-08T00:00:00Z");
    // 03-05 is deliberately missing (a GAP); 03-06 is a repeated bar flagged STALE_BAR by a corporate-action record.
    for (const b of [bar("2026-03-02", "100"), bar("2026-03-03", "101"), bar("2026-03-04", "102"), bar("2026-03-06", "102"), bar("2026-03-09", "103")]) {
      const t = dailyBarTimes(b.session, cal);
      pit.append({
        sourceId: "alpaca.iex.bars.1d",
        sourceLocator: `TST/${b.session}`,
        entityId: "TST",
        observedAt: t.observedAt,
        availableAt: t.availableAt,
        ingestedAt,
        rawContentHash: H,
        adapterVersion: "1.0.0",
        parserVersion: "1.0.0",
        value: rawBarToValue(b),
        qualityFlags: t.flags,
      });
    }
    pit.append(
      corporateActionObservation(
        { kind: "STALE_BAR", entityId: "TST", session: d("2026-03-06"), reason: "provider repeated 03-04 close" },
        { sourceLocator: "quality/TST/2026-03-06", availableAt: utc("2026-03-07T12:00:00Z"), ingestedAt, rawContentHash: H, adapterVersion: "1.0.0", parserVersion: "1.0.0" },
      ),
    );
    return { pit, cal };
  }

  it("reads only bars available at decisionAt (close + 60 min estimate + 15 min processing delay)", () => {
    const { pit, cal } = setup();
    // 2026-03-04 close is 16:00 EST = 21:00Z; availableAt 22:00Z; visible from 22:15Z.
    const early = RawSeries.load({ pit, entityId: "TST", from: d("2026-03-01"), to: d("2026-03-31"), decisionAt: utc("2026-03-04T22:14:59Z"), calendar: cal });
    expect(early.bars.map((b) => b.session)).toEqual(["2026-03-02", "2026-03-03"]);
    const onTime = RawSeries.load({ pit, entityId: "TST", from: d("2026-03-01"), to: d("2026-03-31"), decisionAt: utc("2026-03-04T22:15:00Z"), calendar: cal });
    expect(onTime.bars.map((b) => b.session)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04"]);
    expect(onTime.gaps).toEqual([]);
    expect(onTime.bars[0]?.close.toFixed()).toBe("100");
    expect(onTime.bars[0]?.tradable).toBe(true);
  });

  it("marks gaps and stale bars once they are known, and labels a zero-delay read OPTIMISTIC_DELAY", () => {
    const { pit, cal } = setup();
    const res = RawSeries.load({ pit, entityId: "TST", from: d("2026-03-01"), to: d("2026-03-31"), decisionAt: utc("2026-03-10T00:00:00Z"), calendar: cal });
    expect(res.bars.map((b) => b.session)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-06", "2026-03-09"]);
    expect(res.gaps).toEqual(["2026-03-05"]);
    expect(res.labels).toContain("GAP");
    const stale = res.bars.find((b) => b.session === "2026-03-06");
    expect(stale?.tradable).toBe(false);
    expect(stale?.flags).toContain("STALE_BAR");
    expect(stale?.flags).toContain("GAP"); // first bar after the missing session
    expect(res.bars.find((b) => b.session === "2026-03-09")?.tradable).toBe(true);
    // Before the STALE_BAR record was available the bar looks tradable: the flag itself does not leak.
    const beforeFlag = RawSeries.load({ pit, entityId: "TST", from: d("2026-03-01"), to: d("2026-03-31"), decisionAt: utc("2026-03-07T00:00:00Z"), calendar: cal });
    expect(beforeFlag.bars.find((b) => b.session === "2026-03-06")?.tradable).toBe(true);
    const optimistic = RawSeries.load({
      pit,
      entityId: "TST",
      from: d("2026-03-01"),
      to: d("2026-03-31"),
      decisionAt: utc("2026-03-04T22:00:00Z"),
      calendar: cal,
      processingDelayMs: 0,
    });
    expect(optimistic.labels).toContain("OPTIMISTIC_DELAY");
    expect(optimistic.bars).toHaveLength(3);
    expect(() => RawSeries.load({ pit, entityId: "TST", from: d("2026-03-01"), to: d("2026-03-31"), decisionAt: utc("2026-03-10T00:00:00Z"), calendar: cal, sourceId: "fred.CPI" })).toThrow(
      /bars\.1d/,
    );
  });

  it("the TR series built from a loaded raw series skips the untradable stale bar", () => {
    const { pit, cal } = setup();
    const res = RawSeries.load({ pit, entityId: "TST", from: d("2026-03-01"), to: d("2026-03-31"), decisionAt: utc("2026-03-10T00:00:00Z"), calendar: cal });
    const tr = TotalReturnSeries.build(res.bars, []);
    expect(tr.points.map((p) => p.session)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-09"]);
    expect(tr.points[3]?.trIndex.toFixed()).toBe("1.03");
  });
});
