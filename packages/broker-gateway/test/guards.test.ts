import { describe, expect, it } from "vitest";
import { LIVE_MODES, MODES, addMs, dec, isLiveMode, utc } from "@blackgold/shared";
import {
  AccountBoundaryViolation,
  AllowlistConfigError,
  HardCapViolation,
  LiveModeUnavailableError,
  SleeveAllowlist,
} from "../src/index.ts";
import { OTHER, QUOTE_AT, SLEEVE, T0, makeCaps, makeIntent } from "./helpers.ts";

describe("SleeveAllowlist", () => {
  it("accepts exactly one concrete account id", () => {
    expect(new SleeveAllowlist(SLEEVE).allowedAccountId).toBe(SLEEVE);
    expect(new SleeveAllowlist([SLEEVE]).allowedAccountId).toBe(SLEEVE);
    expect(() => {
      new SleeveAllowlist(SLEEVE).assertSleeve(makeIntent());
    }).not.toThrow();
  });

  it("rejects empty, wildcard, and multiple ids at construction", () => {
    for (const bad of ["", "   ", "*", "SLEEVE-*", "SLEEVE-?", "%", "A,B", "A B"]) {
      expect(() => new SleeveAllowlist(bad), JSON.stringify(bad)).toThrow(AllowlistConfigError);
    }
    expect(() => new SleeveAllowlist([])).toThrow(AllowlistConfigError);
    expect(() => new SleeveAllowlist([SLEEVE, OTHER])).toThrow(AllowlistConfigError);
    expect(() => new SleeveAllowlist([SLEEVE, SLEEVE])).toThrow(AllowlistConfigError);
  });

  it("rejects an intent for any other account without echoing the id", () => {
    const allow = new SleeveAllowlist(SLEEVE);
    const intent = makeIntent({ sleeveAccountId: OTHER });
    let caught: unknown;
    try {
      allow.assertSleeve(intent);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AccountBoundaryViolation);
    expect(String(caught)).not.toContain(OTHER);
    expect(allow.isAllowed(OTHER)).toBe(false);
    expect(allow.isAllowed("")).toBe(false);
    expect(allow.isAllowed("*")).toBe(false);
  });
});

describe("HardCaps", () => {
  const caps = makeCaps();

  it("passes a well-formed intent inside every cap", () => {
    expect(caps.check(makeIntent(), T0)).toEqual({ ok: true, reasonCodes: [] });
    expect(() => {
      caps.assert(makeIntent(), T0);
    }).not.toThrow();
  });

  it("ACCOUNT_MISMATCH: second layer of the sleeve check", () => {
    expect(caps.check(makeIntent({ sleeveAccountId: OTHER }), T0).reasonCodes).toContain("ACCOUNT_MISMATCH");
  });

  it("LIVE_UNAVAILABLE: every live mode is rejected and throws on assert", () => {
    expect(LIVE_MODES.length).toBeGreaterThan(0);
    for (const mode of LIVE_MODES) {
      const v = caps.check(makeIntent({ mode }), T0);
      expect(v.ok, mode).toBe(false);
      expect(v.reasonCodes, mode).toContain("LIVE_UNAVAILABLE");
      expect(() => {
        caps.assertMode(mode);
      }, mode).toThrow(LiveModeUnavailableError);
      expect(() => {
        caps.assert(makeIntent({ mode }), T0);
      }, mode).toThrow(LiveModeUnavailableError);
      // An authorization reference changes nothing in Phase 0: there is no verifier and no live path.
      expect(caps.check(makeIntent({ mode, authorizationRef: "auth_fixture" }), T0).reasonCodes).toContain("LIVE_UNAVAILABLE");
    }
  });

  it("every non-live mode passes the mode check", () => {
    const nonLive = MODES.filter((m) => !isLiveMode(m));
    expect(nonLive.length + LIVE_MODES.length).toBe(MODES.length);
    for (const mode of nonLive) {
      expect(caps.check(makeIntent({ mode }), T0).reasonCodes, mode).not.toContain("LIVE_UNAVAILABLE");
      expect(() => {
        caps.assertMode(mode);
      }, mode).not.toThrow();
    }
  });

  it("NOTIONAL_CAP: exactly at the cap passes, one cent over fails", () => {
    // 100 shares at 500.00 = 50000.00 = cap.
    const at = makeIntent({ quantity: dec(100), limitPrice: dec("500.00") });
    expect(caps.check(at, T0).ok).toBe(true);
    // 100 shares at 500.0001 = 50000.01.
    const over = makeIntent({ quantity: dec(100), limitPrice: dec("500.0001") });
    expect(caps.check(over, T0).reasonCodes).toEqual(["NOTIONAL_CAP"]);
  });

  it("NOTIONAL_CAP for MARKET orders uses the adverse side of the quote", () => {
    const tight = makeCaps({ maxOrderNotional: dec("45002") });
    const buy = makeIntent({ orderType: "MARKET", limitPrice: undefined });
    expect(tight.check(buy, T0).ok).toBe(true); // 100 * 450.02 = 45002
    const wider = makeIntent({ orderType: "MARKET", limitPrice: undefined, quote: { ...buy.quote, ask: dec("450.03") } });
    expect(tight.check(wider, T0).reasonCodes).toEqual(["NOTIONAL_CAP"]);
    const sell = makeIntent({ orderType: "MARKET", limitPrice: undefined, side: "SELL" });
    expect(makeCaps({ maxOrderNotional: dec("44998") }).check(sell, T0).ok).toBe(true); // 100 * 449.98
  });

  it("QTY_CAP: exactly at the cap passes, one share over fails", () => {
    const loose = makeCaps({ maxOrderNotional: dec("1000000") });
    expect(loose.check(makeIntent({ quantity: dec(500) }), T0).ok).toBe(true);
    expect(loose.check(makeIntent({ quantity: dec(501) }), T0).reasonCodes).toEqual(["QTY_CAP"]);
  });

  it("BAD_QTY: zero and negative quantities fail", () => {
    expect(caps.check(makeIntent({ quantity: dec(0) }), T0).reasonCodes).toContain("BAD_QTY");
    expect(caps.check(makeIntent({ quantity: dec(-1) }), T0).reasonCodes).toContain("BAD_QTY");
  });

  it("ORDER_TYPE, TIF, SIDE: anything outside the allowed sets fails", () => {
    const limitOnly = makeCaps({ allowedOrderTypes: ["LIMIT"] });
    expect(limitOnly.check(makeIntent({ orderType: "MARKET", limitPrice: undefined }), T0).reasonCodes).toEqual(["ORDER_TYPE"]);
    expect(caps.check(makeIntent({ timeInForce: "GTC" }), T0).reasonCodes).toEqual(["TIF"]);
    const buyOnly = makeCaps({ allowedSides: ["BUY"] });
    expect(buyOnly.check(makeIntent({ side: "SELL" }), T0).reasonCodes).toEqual(["SIDE"]);
  });

  it("EXTENDED_HOURS: regular session only", () => {
    expect(caps.check(makeIntent({ extendedHours: true }), T0).reasonCodes).toEqual(["EXTENDED_HOURS"]);
    expect(caps.check(makeIntent({ extendedHours: false }), T0).ok).toBe(true);
  });

  it("FRACTIONAL: whole shares only", () => {
    expect(caps.check(makeIntent({ quantity: dec("10.5") }), T0).reasonCodes).toEqual(["FRACTIONAL"]);
    expect(caps.check(makeIntent({ quantity: dec("0.999") }), T0).reasonCodes).toEqual(["FRACTIONAL"]);
  });

  it("STALE_QUOTE: exactly maxQuoteAgeMs old passes, one millisecond older fails, future fails", () => {
    const atLimit = makeIntent({ quote: { ...makeIntent().quote, at: addMs(T0, -5_000) } });
    expect(caps.check(atLimit, T0).ok).toBe(true);
    const tooOld = makeIntent({ quote: { ...makeIntent().quote, at: addMs(T0, -5_001) } });
    expect(caps.check(tooOld, T0).reasonCodes).toEqual(["STALE_QUOTE"]);
    const future = makeIntent({ quote: { ...makeIntent().quote, at: addMs(T0, 1) } });
    expect(caps.check(future, T0).reasonCodes).toEqual(["STALE_QUOTE"]);
    expect(QUOTE_AT).toBe(utc("2026-09-08T14:29:59Z"));
  });

  it("BAD_LIMIT: LIMIT orders need a positive limit price", () => {
    expect(caps.check(makeIntent({ limitPrice: undefined }), T0).reasonCodes).toEqual(["BAD_LIMIT"]);
    expect(caps.check(makeIntent({ limitPrice: dec(0) }), T0).reasonCodes).toEqual(["BAD_LIMIT"]);
    expect(caps.check(makeIntent({ limitPrice: dec("-1") }), T0).reasonCodes).toEqual(["BAD_LIMIT"]);
  });

  it("reports every failing reason at once and assert() throws HardCapViolation with them", () => {
    const intent = makeIntent({ quantity: dec("1000.5"), timeInForce: "GTC", extendedHours: true });
    const v = caps.check(intent, T0);
    expect(v.ok).toBe(false);
    expect([...v.reasonCodes].sort()).toEqual(["EXTENDED_HOURS", "FRACTIONAL", "NOTIONAL_CAP", "QTY_CAP", "TIF"]);
    let caught: unknown;
    try {
      caps.assert(intent, T0);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HardCapViolation);
    if (caught instanceof HardCapViolation) expect([...caught.reasonCodes].sort()).toEqual([...v.reasonCodes].sort());
  });

  it("refuses non-positive caps at construction", () => {
    expect(() => makeCaps({ maxOrderNotional: dec(0) })).toThrow(RangeError);
    expect(() => makeCaps({ maxOrderQty: dec(-5) })).toThrow(RangeError);
    expect(() => makeCaps({ maxQuoteAgeMs: 0 })).toThrow(RangeError);
  });
});
