import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, sha256Hex, utc, type UtcInstant } from "@blackgold/shared";
import { PointInTimeRepository, openCoreDb } from "../src/index.ts";
import { ssgaHoldingsSourceId, type SsgaHoldingsValue } from "../src/data/adapters/ssga-holdings.ts";
import { ThemeMembershipConfigSchema, RestrictedListConfigSchema, type ThemeMembershipConfig, type RestrictedListConfig } from "../src/config/schema.ts";
import { entityMapResolver, lookThroughParamsOf, storedHoldingsOf, storedLookThroughResolver, themeMembershipOf } from "../src/compliance/theme-membership.ts";
import { EntityMap } from "../src/market/entity-map.ts";

const H = `sha256:${sha256Hex("holdings")}`;

/** Owner-shaped fake config, run through the real schema so the test exercises the parsed shape. */
const MEMBERSHIP: ThemeMembershipConfig = ThemeMembershipConfigSchema.parse({
  asOf: "2026-09-01",
  maxAggregateThemeWeightPct: "0.10",
  maxHoldingsAgeDays: 7,
  issuers: [
    { symbols: ["PROC", "PROC.B"], entityId: "PROC_CORP", themes: ["soybean_processing"] },
    { symbols: ["AGRI"], themes: ["crop_inputs", "soybean_processing"] },
  ],
});

const RESTRICTED: RestrictedListConfig = RestrictedListConfigSchema.parse({
  asOf: "2026-09-01",
  themes: ["soybean_processing", "crop_inputs"],
});

describe("themeMembershipOf", () => {
  const membership = themeMembershipOf(MEMBERSHIP);

  it("matches by any listed symbol and by resolved entity id, and returns [] for a non-member", () => {
    expect(membership({ symbol: "PROC" })).toEqual(["soybean_processing"]);
    expect(membership({ symbol: "PROC.B" })).toEqual(["soybean_processing"]);
    expect(membership({ symbol: "UNRELATED", entityId: "PROC_CORP" })).toEqual(["soybean_processing"]);
    expect(membership({ symbol: "UNRELATED" })).toEqual([]);
  });

  it("unions themes when a constituent matches more than one entry", () => {
    // AGRI by symbol plus PROC_CORP by entity id: the union, not either entry alone.
    expect(membership({ symbol: "AGRI", entityId: "PROC_CORP" })).toEqual(["crop_inputs", "soybean_processing"]);
  });
});

describe("lookThroughParamsOf", () => {
  it("takes the restricted themes from the restricted list and the two policy values from the membership config", () => {
    const params = lookThroughParamsOf(MEMBERSHIP, RESTRICTED);
    expect(params.restrictedThemes).toEqual(["soybean_processing", "crop_inputs"]);
    expect(params.maxAggregateThemeWeightPct.toFixed(2)).toBe("0.10");
    expect(params.maxHoldingsAgeDays).toBe(7);
  });
});

// ---------------------------------------------------------------------------------------------
// Store-backed reads
// ---------------------------------------------------------------------------------------------

function coreDb() {
  const dir = mkdtempSync(join(tmpdir(), "bg-theme-"));
  return openCoreDb({ dbPath: join(dir, "t.sqlite") }).db;
}

function repo(db = coreDb()): PointInTimeRepository {
  return new PointInTimeRepository(db, { clock: () => Date.parse("2026-09-10T00:00:00Z") });
}

/** Append one holdings observation the way ssgaHoldingsObservations stamps it (fetch instant = availability = vintage). */
function appendHoldings(pit: PointInTimeRepository, etf: string, asOfStr: string, fetchedAt: UtcInstant, lines: { symbol: string; weight: string }[]): void {
  const asOf = isoDate(asOfStr);
  const value: SsgaHoldingsValue = { etf, asOf, lines };
  pit.append({
    sourceId: ssgaHoldingsSourceId(etf),
    sourceLocator: `ssga/holdings/${etf}/${asOf}`,
    entityId: etf,
    effectiveAt: utc(`${asOf}T00:00:00.000Z`),
    availableAt: fetchedAt,
    vintageAt: fetchedAt,
    ingestedAt: fetchedAt,
    rawContentHash: H,
    adapterVersion: "1.0.0",
    parserVersion: "1.0.0",
    value,
    qualityFlags: ["AVAILABLE_AT_ESTIMATED"],
  });
}

const DECISION_AT = utc("2026-09-08T21:00:00Z");

describe("storedHoldingsOf", () => {
  it("returns the newest admissible as-of date, not merely the last row", () => {
    const pit = repo();
    // Deliberately ingested out of order: the newer as-of arrives first, so "last row wins" would be wrong.
    appendHoldings(pit, "XLI", "2026-09-05", utc("2026-09-06T01:00:00Z"), [{ symbol: "NEW", weight: "1.0" }]);
    appendHoldings(pit, "XLI", "2026-09-03", utc("2026-09-06T02:00:00Z"), [{ symbol: "OLD", weight: "1.0" }]);
    const h = storedHoldingsOf(pit, { decisionAt: DECISION_AT, processingDelayMs: 0 })("XLI");
    expect(h?.asOf).toBe("2026-09-05");
    expect(h?.lines.map((l) => l.symbol)).toEqual(["NEW"]);
  });

  it("a corrected re-publication of the same as-of date supersedes only once its own fetch is admissible", () => {
    const pit = repo();
    appendHoldings(pit, "XLI", "2026-09-05", utc("2026-09-06T01:00:00Z"), [{ symbol: "ORIGINAL", weight: "1.0" }]);
    appendHoldings(pit, "XLI", "2026-09-05", utc("2026-09-09T01:00:00Z"), [{ symbol: "CORRECTED", weight: "1.0" }]);
    const read = (at: UtcInstant) => storedHoldingsOf(pit, { decisionAt: at, processingDelayMs: 0 })("XLI");
    // Decision before the correction was fetched still reads the original (no retroactive read-back)...
    expect(read(DECISION_AT)?.lines[0]?.symbol).toBe("ORIGINAL");
    // ...and one after it reads the correction.
    expect(read(utc("2026-09-09T02:00:00Z"))?.lines[0]?.symbol).toBe("CORRECTED");
  });

  it("returns undefined when nothing is stored or nothing is admissible yet", () => {
    const pit = repo();
    expect(storedHoldingsOf(pit, { decisionAt: DECISION_AT, processingDelayMs: 0 })("XLP")).toBeUndefined();
    appendHoldings(pit, "XLP", "2026-09-05", utc("2026-09-09T01:00:00Z"), [{ symbol: "A", weight: "1.0" }]);
    // Stored, but fetched after the decision instant: unknown at that decision, not readable early.
    expect(storedHoldingsOf(pit, { decisionAt: DECISION_AT, processingDelayMs: 0 })("XLP")).toBeUndefined();
  });

  it("rehydrates weights as Dec fractions of NAV", () => {
    const pit = repo();
    appendHoldings(pit, "XLI", "2026-09-05", utc("2026-09-06T01:00:00Z"), [{ symbol: "A", weight: "0.031" }]);
    const h = storedHoldingsOf(pit, { decisionAt: DECISION_AT, processingDelayMs: 0 })("XLI");
    expect(h?.lines[0]?.weight.toFixed(3)).toBe("0.031");
  });
});

describe("storedLookThroughResolver", () => {
  // Weights are varied across the 0.10 threshold - the dimension the admissibility branch runs on - so an
  // implementation that inverted or ignored the threshold fails one of the two ETFs.
  function seeded(): PointInTimeRepository {
    const pit = repo();
    appendHoldings(pit, "XLI", "2026-09-05", utc("2026-09-06T01:00:00Z"), [
      { symbol: "PROC", weight: "0.08" },
      { symbol: "PROC.B", weight: "0.06" }, // second share class: aggregate 0.14 > 0.10
      { symbol: "CLEAN", weight: "0.86" },
    ]);
    appendHoldings(pit, "XLP", "2026-09-05", utc("2026-09-06T01:00:00Z"), [
      { symbol: "AGRI", weight: "0.09" }, // 0.09 <= 0.10: admissible
      { symbol: "CLEAN", weight: "0.91" },
    ]);
    return pit;
  }
  const SCOPE = ["XLI", "XLP", "XLE"]; // the charter's look_through_flagged set for these fixtures
  const resolve = (pit: PointInTimeRepository, at: UtcInstant) =>
    storedLookThroughResolver(pit, MEMBERSHIP, RESTRICTED, { decisionAt: at, processingDelayMs: 0, lookThroughScope: SCOPE });

  it("blocks an ETF over the aggregate threshold with its present themes, clears one within it, fails closed on no holdings", () => {
    const pit = seeded();
    const lookThrough = resolve(pit, DECISION_AT);
    expect(lookThrough("XLI")).toEqual(["soybean_processing"]);
    expect(lookThrough("XLP")).toEqual([]);
    expect(lookThrough("XLE")).toBeUndefined();
  });

  it("fails closed once the stored holdings are older than maxHoldingsAgeDays", () => {
    const pit = seeded();
    // Same store, decision 8 days after the 2026-09-05 as-of: beyond the 7-day limit -> unknown.
    const lookThrough = resolve(pit, utc("2026-09-13T21:00:00Z"));
    expect(lookThrough("XLP")).toBeUndefined();
  });

  it("counts only themes on the restricted list", () => {
    const pit = seeded();
    const narrowed = RestrictedListConfigSchema.parse({ asOf: "2026-09-01", themes: ["crop_inputs"] });
    const lookThrough = storedLookThroughResolver(pit, MEMBERSHIP, narrowed, { decisionAt: DECISION_AT, processingDelayMs: 0, lookThroughScope: SCOPE });
    // XLI's exposure is soybean_processing, which is off the list: aggregate 0 -> admissible.
    expect(lookThrough("XLI")).toEqual([]);
  });

  it("clears an ETF outside the charter's look_through_flagged scope without a holdings read (Codex P1)", () => {
    const pit = seeded();
    const lookThrough = resolve(pit, DECISION_AT);
    // VTI is a charter risk ETF with no SSGA holdings source; the signed charter does not flag it for
    // look-through, so it clears rather than blocking the whole book as UNKNOWN_LOOK_THROUGH...
    expect(lookThrough("VTI")).toEqual([]);
    // ...while a FLAGGED ETF with no stored holdings still fails closed - the scope never weakens in-scope checks.
    expect(lookThrough("XLE")).toBeUndefined();
  });

  it("matches an aliased constituent through the point-in-time entity map (Codex P1)", () => {
    const db = coreDb();
    const pit = repo(db);
    const map = new EntityMap(db, { clock: () => Date.parse("2026-09-10T00:00:00Z") });
    // The workbook lists the restricted issuer under an alias the membership config does not enumerate;
    // only the entity map knows PROCX belonged to PROC_CORP on the holdings as-of date.
    map.register({ symbol: "PROCX", entityId: "PROC_CORP", effectiveFrom: isoDate("2026-01-01"), source: "test" });
    appendHoldings(pit, "XLI", "2026-09-05", utc("2026-09-06T01:00:00Z"), [
      { symbol: "PROCX", weight: "0.14" }, // over the 0.10 threshold, but only via the resolved entity id
      { symbol: "CLEAN", weight: "0.86" },
    ]);
    const base = { decisionAt: DECISION_AT, processingDelayMs: 0, lookThroughScope: SCOPE } as const;
    // Without identity resolution the alias reads as unrestricted (the documented ticker-only limitation)...
    expect(storedLookThroughResolver(pit, MEMBERSHIP, RESTRICTED, base)("XLI")).toEqual([]);
    // ...with the entity map wired, the aliased issuer is caught and the ETF blocks.
    const withMap = storedLookThroughResolver(pit, MEMBERSHIP, RESTRICTED, { ...base, resolveEntityId: entityMapResolver(map, DECISION_AT) });
    expect(withMap("XLI")).toEqual(["soybean_processing"]);
  });
});
