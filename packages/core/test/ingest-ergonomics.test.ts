import { describe, expect, it } from "vitest";
import { addDays, isoDate } from "@blackgold/shared";
import { parseAppConfig } from "../src/config/load.ts";
import { resolveUniverseIngest, UNIVERSE_LOOKBACK_DAYS, UsageError } from "../src/ingest/run.ts";

describe("secUserAgentContact accepts the SEC name-plus-email contact form", () => {
  const contactOf = (contact: string): string | undefined =>
    parseAppConfig({ dataDir: "./data", sources: { secUserAgentContact: contact } }).sources.secUserAgentContact;

  it("accepts a bare email", () => {
    expect(contactOf("ops@example.com")).toBe("ops@example.com");
  });

  it("accepts name-plus-email, the SEC fair-access User-Agent form", () => {
    // This is the exact shape SEC's fair-access policy asks for and the one that previously failed validation.
    expect(contactOf("Matt Herman ops@example.com")).toBe("Matt Herman ops@example.com");
  });

  it("rejects a contact that names no email", () => {
    expect(() => parseAppConfig({ dataDir: "./data", sources: { secUserAgentContact: "Matt Herman" } })).toThrow(/contact email/);
  });
});

describe("resolveUniverseIngest", () => {
  const ranges = [
    { start: isoDate("2007-06-01"), end: isoDate("2018-12-31") },
    { start: isoDate("2019-01-01"), end: isoDate("2024-12-31") },
    { start: isoDate("2025-01-01"), end: isoDate("2026-09-06") },
  ];

  it("dedupes and sorts members and spans earliest-with-lookback through latest", () => {
    const plan = resolveUniverseIngest(["VTI", "QQQ", "VTI", "BIL"], ranges, { actions: "tiingo" });
    expect(plan.symbols).toEqual(["BIL", "QQQ", "VTI"]);
    expect(plan.source).toBe("tiingo");
    expect(plan.actions).toBe("tiingo");
    expect(plan.start).toBe(addDays(isoDate("2007-06-01"), -UNIVERSE_LOOKBACK_DAYS));
    expect(plan.end).toBe("2026-09-06");
  });

  it("honours explicit start, end, source, and actions overrides", () => {
    const plan = resolveUniverseIngest(["VTI"], ranges, { start: "2010-01-01", end: "2011-01-01", source: "alpaca", actions: "none" });
    expect(plan).toEqual({ symbols: ["VTI"], start: isoDate("2010-01-01"), end: isoDate("2011-01-01"), source: "alpaca", actions: "none" });
  });

  it("requires an explicit --actions choice (guards against double-counting corporate actions)", () => {
    expect(() => resolveUniverseIngest(["VTI"], ranges, { source: "tiingo" })).toThrow(UsageError);
    expect(() => resolveUniverseIngest(["VTI"], ranges, { source: "tiingo", actions: "maybe" })).toThrow(UsageError);
  });

  it("rejects --actions tiingo with a non-tiingo bars source", () => {
    expect(() => resolveUniverseIngest(["VTI"], ranges, { source: "alpaca", actions: "tiingo" })).toThrow(UsageError);
  });

  it("rejects an unknown source", () => {
    expect(() => resolveUniverseIngest(["VTI"], ranges, { source: "yahoo", actions: "none" })).toThrow(UsageError);
  });

  it("turns a malformed --start/--end into a usage error, not a crash", () => {
    expect(() => resolveUniverseIngest(["VTI"], ranges, { actions: "none", start: "2020-13-99" })).toThrow(UsageError);
    expect(() => resolveUniverseIngest(["VTI"], ranges, { actions: "none", end: "not-a-date" })).toThrow(UsageError);
  });

  it("rejects an end before the start", () => {
    expect(() => resolveUniverseIngest(["VTI"], ranges, { actions: "none", start: "2020-01-01", end: "2019-01-01" })).toThrow(UsageError);
  });

  it("rejects an empty universe", () => {
    expect(() => resolveUniverseIngest([], ranges, { actions: "none" })).toThrow(UsageError);
  });
});
