import { describe, expect, it } from "vitest";
import { Dec, dec, isoDate } from "@blackgold/shared";
import { InsufficientCashError, InsufficientQuantityError, MissingPriceError, Portfolio, dailyNavSeries, daysBetween, gainTerm } from "../src/index.ts";

const d = isoDate;
const D = (s: string): Dec => new Dec(s);

describe("Portfolio", () => {
  it("fills move cash and quantity; long-only and cash-funded are enforced", () => {
    const p = new Portfolio(dec(10_000));
    p.applyFill({ entityId: "VTI", side: "BUY", quantity: dec(10), price: D("250"), fees: D("1"), session: d("2026-03-02") });
    expect(p.cash.toFixed()).toBe("7499");
    expect(p.quantity("VTI").toFixed()).toBe("10");
    expect(p.position("VTI")?.costBasis.toFixed()).toBe("2501");
    expect(() => { p.applyFill({ entityId: "VTI", side: "BUY", quantity: dec(100), price: D("250"), fees: D("0"), session: d("2026-03-02") }); }).toThrow(InsufficientCashError);
    expect(() => { p.applyFill({ entityId: "VTI", side: "SELL", quantity: dec(11), price: D("250"), fees: D("0"), session: d("2026-03-03") }); }).toThrow(InsufficientQuantityError);
    expect(() => { p.applyFill({ entityId: "QQQ", side: "SELL", quantity: dec(1), price: D("250"), fees: D("0"), session: d("2026-03-03") }); }).toThrow(InsufficientQuantityError);
    expect(p.nav(new Map([["VTI", D("260")]])).toFixed()).toBe("10099");
    expect(() => p.nav(new Map())).toThrow(MissingPriceError);
    expect(p.investedWeight(new Map([["VTI", D("260")]])).toFixed(6)).toBe("0.257451");
  });

  it("dividends credit cash on the pay-date for the entitled quantity", () => {
    const p = new Portfolio(dec(1_000));
    p.applyFill({ entityId: "VTI", side: "BUY", quantity: dec(4), price: D("100"), fees: D("0"), session: d("2026-03-02") });
    const r = p.applyDividend({ entityId: "VTI", amountPerShare: D("0.85"), payDate: d("2026-03-12") });
    expect(r.amount.toFixed()).toBe("3.4");
    expect(p.cash.toFixed()).toBe("603.4");
    // Sold between ex-date and pay-date: the entitled quantity is what was held at the ex-date.
    p.applyFill({ entityId: "VTI", side: "SELL", quantity: dec(4), price: D("100"), fees: D("0"), session: d("2026-03-13") });
    const r2 = p.applyDividend({ entityId: "VTI", amountPerShare: D("1"), payDate: d("2026-03-20"), entitledQuantity: dec(4) });
    expect(r2.amount.toFixed()).toBe("4");
    expect(p.dividends()).toHaveLength(2);
  });

  it("split multiplies quantity and divides cost per share, leaving total basis unchanged", () => {
    const p = new Portfolio(dec(1_000));
    p.applyFill({ entityId: "X", side: "BUY", quantity: dec(3), price: D("100"), fees: D("0"), session: d("2026-03-02") });
    p.applySplit("X", D("4"));
    expect(p.quantity("X").toFixed()).toBe("12");
    expect(p.position("X")?.lots[0]?.costPerShare.toFixed()).toBe("25");
    expect(p.position("X")?.costBasis.toFixed()).toBe("300");
    p.applySplit("Y", D("2")); // unheld: no-op
    expect(p.nav(new Map([["X", D("25")]])).toFixed()).toBe("1000");
  });

  it("delisting at zero realizes the full loss instead of dropping the name", () => {
    const p = new Portfolio(dec(1_000));
    p.applyFill({ entityId: "DEAD", side: "BUY", quantity: dec(10), price: D("50"), fees: D("0"), session: d("2025-01-02") });
    const gains = p.applyDelisting("DEAD", null, d("2026-03-02"));
    expect(gains).toHaveLength(1);
    expect(gains[0]?.gain.toFixed()).toBe("-500");
    expect(gains[0]?.term).toBe("LONG_TERM");
    expect(p.position("DEAD")).toBeUndefined();
    expect(p.cash.toFixed()).toBe("500");
    expect(p.nav(new Map()).toFixed()).toBe("500");
    const q = new Portfolio(dec(1_000));
    q.applyFill({ entityId: "CASHOUT", side: "BUY", quantity: dec(10), price: D("50"), fees: D("0"), session: d("2026-01-02") });
    q.applyDelisting("CASHOUT", D("55"), d("2026-03-02"));
    expect(q.cash.toFixed()).toBe("1050");
    expect(q.realizedSummary().shortTerm.toFixed()).toBe("50");
  });

  it("FIFO lots with fee allocation and the short/long-term split at one year", () => {
    const p = new Portfolio(dec(10_000));
    p.applyFill({ entityId: "X", side: "BUY", quantity: dec(10), price: D("100"), fees: D("0"), session: d("2024-01-10") });
    p.applyFill({ entityId: "X", side: "BUY", quantity: dec(10), price: D("120"), fees: D("0"), session: d("2025-03-03") });
    p.applyFill({ entityId: "X", side: "SELL", quantity: dec(15), price: D("130"), fees: D("1.5"), session: d("2025-06-02") });
    const gains = p.realizedGains();
    expect(gains).toHaveLength(2);
    expect(gains[0]?.openedAt).toBe("2024-01-10");
    expect(gains[0]?.quantity.toFixed()).toBe("10");
    expect(gains[0]?.proceeds.toFixed()).toBe("1299"); // 1300 - 10 x 0.1 fee
    expect(gains[0]?.costBasis.toFixed()).toBe("1000");
    expect(gains[0]?.gain.toFixed()).toBe("299");
    expect(gains[0]?.term).toBe("LONG_TERM"); // 509 days
    expect(gains[1]?.openedAt).toBe("2025-03-03");
    expect(gains[1]?.quantity.toFixed()).toBe("5");
    expect(gains[1]?.gain.toFixed()).toBe("49.5"); // 650 - 0.5 - 600
    expect(gains[1]?.term).toBe("SHORT_TERM"); // 91 days
    const s = p.realizedSummary();
    expect(s.shortTerm.toFixed()).toBe("49.5");
    expect(s.longTerm.toFixed()).toBe("299");
    expect(s.total.toFixed()).toBe("348.5");
    expect(p.quantity("X").toFixed()).toBe("5");
    expect(p.position("X")?.costBasis.toFixed()).toBe("600");
    expect(p.cash.toFixed()).toBe("9748.5"); // 10000 - 1000 - 1200 + 1950 - 1.5
    // Boundary: exactly 365 days is still short-term; 366 is long-term.
    expect(daysBetween(d("2025-01-01"), d("2026-01-01"))).toBe(365);
    expect(gainTerm(d("2025-01-01"), d("2026-01-01"))).toBe("SHORT_TERM");
    expect(gainTerm(d("2025-01-01"), d("2026-01-02"))).toBe("LONG_TERM");
  });

  it("dailyNavSeries replays events in date order and marks NAV at each close", () => {
    const sessions = [d("2026-03-02"), d("2026-03-03"), d("2026-03-04"), d("2026-03-05")];
    const closes = new Map<string, ReadonlyMap<string, Dec>>([
      ["2026-03-02", new Map([["X", D("100")]])],
      ["2026-03-03", new Map([["X", D("110")]])],
      ["2026-03-04", new Map([["X", D("28")]])], // 4:1 split day
      ["2026-03-05", new Map([["X", D("30")]])],
    ]);
    const { points, portfolio } = dailyNavSeries({
      initialCash: dec(1_000),
      events: [
        { type: "SPLIT", entityId: "X", ratio: D("4"), exDate: d("2026-03-04") },
        { type: "FILL", entityId: "X", side: "BUY", quantity: dec(5), price: D("100"), fees: D("0"), session: d("2026-03-02") },
        { type: "DIVIDEND", entityId: "X", amountPerShare: D("0.5"), payDate: d("2026-03-05") },
      ],
      sessions,
      closes: (s) => closes.get(s) ?? new Map(),
    });
    expect(points.map((p) => p.nav.toFixed())).toEqual(["1000", "1050", "1060", "1110"]); // 500 + 20 x 28 = 1060; 500 + 10 + 600 = 1110
    expect(points[3]?.cash.toFixed()).toBe("510");
    expect(points[3]?.investedWeight.toFixed(4)).toBe("0.5405");
    expect(portfolio.quantity("X").toFixed()).toBe("20");
  });
});
