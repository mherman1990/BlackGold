import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  decodeSsgaHoldings,
  ssgaHoldingsSourceId,
  ssgaHoldingsUrl,
} from "../src/data/adapters/ssga-holdings.ts";
import { SchemaDriftError } from "../src/data/adapters/common.ts";

const FIX = new URL("../../../test/fixtures/ssga/", import.meta.url);
const fixture = (name: string): Uint8Array => readFileSync(new URL(name, FIX));

describe("ssgaHoldingsSourceId / ssgaHoldingsUrl", () => {
  it("names the per-ETF source id and the daily-holdings URL", () => {
    expect(ssgaHoldingsSourceId("xli")).toBe("etf_holdings.ssga.XLI");
    expect(ssgaHoldingsSourceId("XLP")).toBe("etf_holdings.ssga.XLP");
    expect(ssgaHoldingsUrl("XLI")).toBe(
      "https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-xli.xlsx",
    );
  });
});

describe("decodeSsgaHoldings: a well-formed SSGA file", () => {
  it("extracts the ETF, as-of date, and constituents with weights as fractions of NAV", async () => {
    const h = await decodeSsgaHoldings(fixture("holdings-xli.xlsx"), { etf: "XLI" });
    expect(h.etf).toBe("XLI");
    expect(h.asOf).toBe("2026-08-29");
    // The cash line (ticker "-") carries no restricted issuer and is skipped; six constituents remain.
    expect(h.lines.map((l) => l.symbol)).toEqual(["GE", "CAT", "RTX", "UNP", "HON", "DE"]);
    // SSGA's Weight column is a percent of NAV; the decoder stores it as a fraction.
    const bySymbol = new Map(h.lines.map((l) => [l.symbol, l.weight]));
    expect(bySymbol.get("GE")).toBe("0.2");
    expect(bySymbol.get("CAT")).toBe("0.18");
    expect(bySymbol.get("DE")).toBe("0.13");
    expect(h.lines.find((l) => l.symbol === "GE")?.name).toBe("GE Aerospace");
  });

  it("is case-insensitive on the requested ETF and echoes it uppercased", async () => {
    const h = await decodeSsgaHoldings(fixture("holdings-xli.xlsx"), { etf: "xli" });
    expect(h.etf).toBe("XLI");
  });
});

describe("decodeSsgaHoldings: fails closed on every surprise", () => {
  it("rejects bytes that are not a readable workbook", async () => {
    await expect(decodeSsgaHoldings(new TextEncoder().encode("not a workbook"), { etf: "XLI" })).rejects.toBeInstanceOf(SchemaDriftError);
  });

  it("rejects a file whose fund ticker is not the ETF requested (mis-fetched file)", async () => {
    await expect(decodeSsgaHoldings(fixture("holdings-wrongfund.xlsx"), { etf: "XLI" })).rejects.toBeInstanceOf(SchemaDriftError);
  });

  it("rejects a file with no recognizable Name/Ticker/Weight header", async () => {
    await expect(decodeSsgaHoldings(fixture("holdings-noheader.xlsx"), { etf: "XLI" })).rejects.toBeInstanceOf(SchemaDriftError);
  });

  it("rejects a file whose holdings do not sum near 100%", async () => {
    await expect(decodeSsgaHoldings(fixture("holdings-badsum.xlsx"), { etf: "XLI" })).rejects.toBeInstanceOf(SchemaDriftError);
  });

  it("rejects a real constituent with a blank/unreadable weight rather than silently dropping it", async () => {
    // Silently dropping a valid-ticker row with no weight could hide a restricted issuer and fail open.
    await expect(decodeSsgaHoldings(fixture("holdings-blankweight.xlsx"), { etf: "XLI" })).rejects.toBeInstanceOf(SchemaDriftError);
  });
});
