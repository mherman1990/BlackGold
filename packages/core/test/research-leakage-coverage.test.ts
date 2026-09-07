import { describe, expect, it } from "vitest";
import { sha256Hex, utc, type UtcInstant } from "@blackgold/shared";
import { auditReads, LeakageAuditor } from "../src/research/leakage.ts";
import type { AsOfResult } from "../src/data/pit/types.ts";
import { buildCoverageReport, COVERAGE_REPORT_VERSION } from "../src/research/coverage.ts";
import { computeFeatures, type FeatureParams } from "../src/strategy/features.ts";
import { DEFAULT_BARS_SOURCE_ID } from "../src/market/series.ts";
import { defaultProcessingDelayMs } from "../src/data/pit/repository.ts";
import { rawBarToValue } from "../src/market/types.ts";
import { buildMarket, D, N, type PricePath } from "./strategy-fixture.ts";

const SMALL: FeatureParams = {
  momentumLookbackSessions: 20,
  momentumSkipSessions: 4,
  trendSmaSessions: 10,
  volatilitySessions: 15,
  advSessions: 5,
  minAdvUsd: N("1000000"),
};

const PATHS: PricePath[] = [
  { entityId: "AAA", start: N("100"), perSession: N("1.004"), volumeShares: 2_000_000n, wobble: N("0.002") },
  { entityId: "BBB", start: N("50"), perSession: N("1.002"), volumeShares: 3_000_000n, wobble: N("0.006") },
  { entityId: "BIL", start: N("91"), perSession: N("1.00008"), volumeShares: 900_000n },
];

/**
 * The default market is built once and shared; an overridden one (gaps, stale bars) is built per call.
 * Reads only, so sharing cannot couple the tests — see strategy-features.test.ts for the same reasoning.
 */
let sharedMarket: ReturnType<typeof buildMarket> | undefined;
function market(over: Partial<Parameters<typeof buildMarket>[0]> = {}) {
  if (Object.keys(over).length > 0) return buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-06-30"), ...over });
  sharedMarket ??= buildMarket({ paths: PATHS, from: D("2026-01-02"), to: D("2026-06-30") });
  return sharedMarket;
}

const delayOf = (sourceId: string): number => defaultProcessingDelayMs(sourceId);

/**
 * A stub read result. `AsOfResult<never>` is assignable to `AsOfResult<T>` for any T, which is what lets a
 * non-generic stub stand in for the generic `asOf` the interface declares.
 */
function neverResult(result: { rows: unknown[]; labels: string[]; processingDelayMs: number }): AsOfResult<never> {
  return result as AsOfResult<never>;
}

describe("LeakageAuditor", () => {
  it("records every read a feature run made and reports it clean", () => {
    const m = market();
    const audited = auditReads(m.pit, { defaultDelayMs: delayOf });
    computeFeatures(
      { pit: audited, calendar: m.calendar },
      { riskEntities: ["AAA", "BBB"], cashEntityId: "BIL", decisionAt: m.decisionAt(D("2026-05-15")), params: SMALL },
    );
    const report = audited.report();
    expect(report.clean).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.reads).toBeGreaterThan(0);
    expect(report.rowsReturned).toBeGreaterThan(0);
    expect(report.sources).toContain(DEFAULT_BARS_SOURCE_ID);
    expect(report.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Every row the run used was published strictly before it was allowed to be read.
    expect(report.minMarginMs).toBeGreaterThanOrEqual(0);
  });

  it("catches a row that becomes available after the decision instant", () => {
    // A stub read path that hands back a row published a day after the decision. The real repository would
    // never return it; the audit's job is to notice independently if one ever did.
    const at: UtcInstant = utc("2026-05-15T21:00:00Z");
    const auditor = new LeakageAuditor(
      {
        asOf: () => neverResult({
          rows: [
            {
              id: 42,
              sourceId: "test.series",
              sourceLocator: "loc",
              entityId: "AAA",
              effectiveAt: utc("2026-05-15T00:00:00Z"),
              availableAt: utc("2026-05-16T21:00:00Z"),
              ingestedAt: at,
              rawContentHash: `sha256:${sha256Hex("x")}`,
              adapterVersion: "1",
              parserVersion: "1",
              value: {},
              qualityFlags: [],
            },
          ],
          labels: [],
          processingDelayMs: 0,
        }),
      },
      { defaultDelayMs: () => 0 },
    );
    auditor.asOf({ sourceId: "test.series", decisionAt: at });
    const report = auditor.report();
    expect(report.clean).toBe(false);
    expect(report.violations[0]?.kind).toBe("FUTURE_AVAILABILITY");
    expect(report.violations[0]?.observationId).toBe(42);
    expect(report.minMarginMs).toBeLessThan(0);
  });

  it("catches a decision loop that walks backwards in time", () => {
    const m = market();
    const audited = auditReads(m.pit, { defaultDelayMs: delayOf });
    const later = m.decisionAt(D("2026-05-15"));
    const earlier = m.decisionAt(D("2026-05-08"));
    audited.asOf({ sourceId: DEFAULT_BARS_SOURCE_ID, entityId: "AAA", decisionAt: later });
    audited.asOf({ sourceId: DEFAULT_BARS_SOURCE_ID, entityId: "AAA", decisionAt: earlier });
    const report = audited.report();
    expect(report.clean).toBe(false);
    expect(report.violations.map((v) => v.kind)).toContain("NON_MONOTONIC_DECISION_ORDER");
  });

  it("flags a run that declares no processing delay for a source that has one", () => {
    const m = market();
    const audited = auditReads(m.pit, { defaultDelayMs: delayOf });
    audited.asOf({ sourceId: DEFAULT_BARS_SOURCE_ID, entityId: "AAA", decisionAt: m.decisionAt(D("2026-05-15")), processingDelayMs: 0 });
    const report = audited.report();
    expect(report.violations.map((v) => v.kind)).toContain("ZERO_DECLARED_DELAY");
    expect(report.zeroDelaySources).toContain(DEFAULT_BARS_SOURCE_ID);
    expect(report.labels).toContain("OPTIMISTIC_DELAY");
  });

  it("catches a row whose effective session is later than the decision session", () => {
    const m = market();
    const audited = auditReads(m.pit, { defaultDelayMs: delayOf });
    const res = audited.asOf({ sourceId: DEFAULT_BARS_SOURCE_ID, entityId: "AAA", decisionAt: m.decisionAt(D("2026-06-30")) });
    // Claim the run belonged to a much earlier decision session than the rows it read.
    audited.checkEffectiveSessions(new Map([["AAA", D("2026-01-15")]]), new Map([["AAA", res.rows]]));
    const report = audited.report();
    expect(report.clean).toBe(false);
    expect(report.violations.some((v) => v.kind === "FUTURE_EFFECTIVE_SESSION")).toBe(true);
  });

  it("stays clean when a future-dated correction sits in the table but is not yet available", () => {
    const m = market();
    const session = D("2026-05-15");
    // A corrected bar for 2026-05-15 published a week later: in the table, invisible to this decision.
    const corrected = { ...rawBarToValue({ symbol: "AAA", session, open: N("1"), high: N("1"), low: N("1"), close: N("1"), volume: 1n, venue: "iex" }) };
    m.pit.append({
      sourceId: DEFAULT_BARS_SOURCE_ID,
      sourceLocator: `${DEFAULT_BARS_SOURCE_ID}/AAA/${session}`,
      entityId: "AAA",
      effectiveAt: utc(`${session}T00:00:00Z`),
      availableAt: utc("2026-05-22T21:30:00Z"),
      ingestedAt: utc("2026-09-07T00:00:00Z"),
      rawContentHash: `sha256:${sha256Hex("corrected")}`,
      adapterVersion: "1.0.0",
      parserVersion: "1.0.0",
      value: corrected,
      qualityFlags: [],
    });
    const audited = auditReads(m.pit, { defaultDelayMs: delayOf });
    const fs = computeFeatures(
      { pit: audited, calendar: m.calendar },
      { riskEntities: ["AAA", "BBB"], cashEntityId: "BIL", decisionAt: m.decisionAt(session), params: SMALL },
    );
    expect(audited.report().clean).toBe(true);
    // The absurd corrected close of 1 did not reach the decision.
    expect(fs.features.get("AAA")?.px?.gt(N("10"))).toBe(true);
  });
});

describe("buildCoverageReport", () => {
  it("reports full coverage for a complete window", () => {
    const m = market();
    const report = buildCoverageReport({
      pit: m.pit,
      calendar: m.calendar,
      entities: ["AAA", "BBB", "BIL"],
      from: D("2026-02-02"),
      to: D("2026-06-30"),
      decisionAt: m.decisionAt(D("2026-06-30")),
    });
    expect(report.version).toBe(COVERAGE_REPORT_VERSION);
    expect(report.reportId).toMatch(/^cov_20260630_[0-9a-f]{8}$/);
    expect(report.uncovered).toEqual([]);
    expect(report.belowMinimum).toEqual([]);
    for (const e of report.entities) {
      expect(e.coveredSessions).toBe(report.expectedSessions);
      expect(e.coverageRatio).toBe("1.000000");
      expect(e.interiorGaps).toEqual([]);
    }
  });

  it("counts interior gaps and drops the coverage ratio", () => {
    const gaps = [D("2026-03-10"), D("2026-03-11"), D("2026-03-12")];
    const m = market({ omitSessions: { BBB: gaps } });
    const report = buildCoverageReport({
      pit: m.pit,
      calendar: m.calendar,
      entities: ["AAA", "BBB"],
      from: D("2026-02-02"),
      to: D("2026-06-30"),
      decisionAt: m.decisionAt(D("2026-06-30")),
    });
    const bbb = report.entities.find((e) => e.entityId === "BBB");
    expect(bbb?.interiorGaps).toEqual(gaps);
    expect(bbb?.coveredSessions).toBe(report.expectedSessions - 3);
    expect(bbb?.coverageRatio.startsWith("0.9")).toBe(true);
    expect(report.labels).toContain("GAP");
  });

  it("separates leading absence from an interior gap", () => {
    const m = market();
    // A window that starts before the fixture does: the missing head is history the entity lacks, not a gap.
    const report = buildCoverageReport({
      pit: m.pit,
      calendar: m.calendar,
      entities: ["AAA"],
      from: D("2025-10-01"),
      to: D("2026-06-30"),
      decisionAt: m.decisionAt(D("2026-06-30")),
    });
    const aaa = report.entities[0];
    expect(aaa?.leadingAbsent).toBeGreaterThan(0);
    expect(aaa?.interiorGaps).toEqual([]);
    expect(aaa?.firstSession).toBe(D("2026-01-02"));
    expect(report.belowMinimum).toEqual(["AAA"]);
  });

  it("counts stale bars and names the codes that bar promotion evidence", () => {
    const m = market({ staleSessions: { AAA: [D("2026-03-10"), D("2026-03-11")] } });
    const report = buildCoverageReport({
      pit: m.pit,
      calendar: m.calendar,
      entities: ["AAA"],
      from: D("2026-02-02"),
      to: D("2026-06-30"),
      decisionAt: m.decisionAt(D("2026-06-30")),
    });
    const aaa = report.entities[0];
    expect(aaa?.staleBars).toBe(2);
    expect(aaa?.qualityCounts["STALE_BAR"]).toBe(2);
    expect(aaa?.actionCounts["STALE_BAR"]).toBe(2);
    // STALE_BAR does not bar promotion evidence, so it appears as a blocking-for-decisions code only.
    expect(report.promotionBlockingCodes).toEqual([]);
  });

  it("lists an entity with no bars at all as uncovered", () => {
    const m = market();
    const report = buildCoverageReport({
      pit: m.pit,
      calendar: m.calendar,
      entities: ["AAA", "NOSUCH"],
      from: D("2026-02-02"),
      to: D("2026-06-30"),
      decisionAt: m.decisionAt(D("2026-06-30")),
    });
    expect(report.uncovered).toEqual(["NOSUCH"]);
    const none = report.entities.find((e) => e.entityId === "NOSUCH");
    expect(none?.coveredSessions).toBe(0);
    expect(none?.coverageRatio).toBe("0.000000");
    expect(none?.leadingAbsent).toBe(report.expectedSessions);
  });

  it("measures coverage as of the stated instant, not from the current table", () => {
    const m = market();
    const early = buildCoverageReport({
      pit: m.pit,
      calendar: m.calendar,
      entities: ["AAA"],
      from: D("2026-01-02"),
      to: D("2026-06-30"),
      decisionAt: m.decisionAt(D("2026-03-31")),
    });
    const late = buildCoverageReport({
      pit: m.pit,
      calendar: m.calendar,
      entities: ["AAA"],
      from: D("2026-01-02"),
      to: D("2026-06-30"),
      decisionAt: m.decisionAt(D("2026-06-30")),
    });
    // Read from March, the second quarter has not happened yet.
    expect(early.entities[0]?.coveredSessions).toBeLessThan(late.entities[0]?.coveredSessions ?? 0);
    expect(early.entities[0]?.trailingAbsent).toBeGreaterThan(0);
    expect(late.entities[0]?.trailingAbsent).toBe(0);
    expect(early.reportId).not.toBe(late.reportId);
  });

  it("hashes deterministically and rejects a reversed window", () => {
    const m = market();
    const args = {
      pit: m.pit,
      calendar: m.calendar,
      entities: ["AAA", "BBB"],
      from: D("2026-02-02"),
      to: D("2026-06-30"),
      decisionAt: m.decisionAt(D("2026-06-30")),
    };
    expect(buildCoverageReport(args).reportHash).toBe(buildCoverageReport(args).reportHash);
    expect(() => buildCoverageReport({ ...args, from: D("2026-06-30"), to: D("2026-02-02") })).toThrow(RangeError);
  });

  it("audits cleanly when the coverage report itself goes through the auditor", () => {
    const m = market();
    const audited = auditReads(m.pit, { defaultDelayMs: delayOf });
    buildCoverageReport({
      pit: audited,
      calendar: m.calendar,
      entities: ["AAA", "BBB", "BIL"],
      from: D("2026-02-02"),
      to: D("2026-06-30"),
      decisionAt: m.decisionAt(D("2026-06-30")),
    });
    expect(audited.report().clean).toBe(true);
  });
});
