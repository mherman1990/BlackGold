import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dec, ONE, ZERO, addMs, isoDate, sha256Hex, utc, type IsoDate, type UtcInstant } from "@blackgold/shared";
import {
  auditReads,
  computeFeatures,
  corporateActionObservation,
  DEFAULT_BARS_SOURCE_ID,
  defaultProcessingDelayMs,
  NyseCalendar,
  openCoreDb,
  PointInTimeRepository,
  rawBarToValue,
  selectCandidates,
  STALE_ANCHOR,
  type FeatureParams,
  type PointInTimeObservation,
} from "@blackgold/core";

/**
 * Temporal fixtures for the Phase 2 decision path (docs/DATA_PROVENANCE_SPEC.md, PLAN.md Phase 2 exit).
 *
 * Phase 1 proved the store cannot return a future observation. These fixtures prove the property that
 * matters one layer up: a decision taken at a point in time does not change when the future arrives. Each
 * fixture takes a decision, then inserts something that would have changed it - a corrected bar, a late
 * dividend, a revised close - and re-takes the same decision at the same instant, asserting the answer is
 * byte-identical.
 */

const CAL = new NyseCalendar();
const N = (s: string): Dec => new Dec(s);
const D = (s: string): IsoDate => isoDate(s);
const ADAPTER = "1.0.0";
const INGESTED = utc("2026-09-07T00:00:00Z");
const PUBLISH_DELAY_MS = 30 * 60_000;

const PARAMS: FeatureParams = {
  momentumLookbackSessions: 20,
  momentumSkipSessions: 4,
  trendSmaSessions: 10,
  volatilitySessions: 15,
  advSessions: 5,
  minAdvUsd: N("1000000"),
};

const CANDIDATE_PARAMS = {
  entryRank: 3,
  holdRank: 4,
  maxPositions: 3,
  maxNewPositionsPerDecision: 3,
  minAdvUsd: N("1000000"),
  clusters: [],
};

function repo(): PointInTimeRepository {
  const dir = mkdtempSync(join(tmpdir(), "bg-temporal-strategy-"));
  return new PointInTimeRepository(openCoreDb({ dbPath: join(dir, "t.sqlite") }).db, { clock: () => Date.parse(INGESTED) });
}

function appendBar(pit: PointInTimeRepository, entityId: string, session: IsoDate, close: Dec, opts: { availableAt?: UtcInstant; locatorSuffix?: string } = {}): void {
  const obs: PointInTimeObservation<Record<string, unknown>> = {
    sourceId: DEFAULT_BARS_SOURCE_ID,
    sourceLocator: `${DEFAULT_BARS_SOURCE_ID}/${entityId}/${session}${opts.locatorSuffix ?? ""}`,
    entityId,
    effectiveAt: utc(`${session}T00:00:00Z`),
    availableAt: opts.availableAt ?? addMs(CAL.sessionClose(session), PUBLISH_DELAY_MS),
    ingestedAt: INGESTED,
    rawContentHash: `sha256:${sha256Hex(`${entityId}:${session}:${close.toFixed()}`)}`,
    adapterVersion: ADAPTER,
    parserVersion: ADAPTER,
    value: rawBarToValue({ symbol: entityId, session, open: close, high: close, low: close, close, volume: 2_000_000n, venue: "iex" }),
    qualityFlags: [],
  };
  pit.append(obs);
}

/** A market of three risers and a cash leg over one calendar half-year. */
function seed(pit: PointInTimeRepository, from: IsoDate, to: IsoDate): IsoDate[] {
  const sessions = CAL.sessionDates(from, to);
  const paths: [string, string, string][] = [
    ["AAA", "100", "1.004"],
    ["BBB", "50", "1.002"],
    ["CCC", "80", "1.001"],
    ["BIL", "91", "1.00008"],
  ];
  for (const [entityId, start, step] of paths) {
    sessions.forEach((session, i) => {
      appendBar(pit, entityId, session, N(start).times(N(step).pow(i)));
    });
  }
  return sessions;
}

const RISK = ["AAA", "BBB", "CCC"];

function decide(pit: PointInTimeRepository, decisionAt: UtcInstant, held: ReadonlySet<string> = new Set()) {
  const fs = computeFeatures({ pit, calendar: CAL }, { riskEntities: RISK, cashEntityId: "BIL", decisionAt, params: PARAMS });
  const candidates = selectCandidates({ features: fs, held, params: CANDIDATE_PARAMS });
  return { fs, candidates };
}

/** Everything about a decision that a later observation must not be able to change. */
function fingerprint(out: ReturnType<typeof decide>): string {
  return JSON.stringify({
    anchor: out.fs.anchorSession,
    selected: out.candidates.selected,
    exits: out.candidates.exits,
    entries: out.candidates.entries,
    reasons: out.candidates.candidates.map((c) => [c.entityId, c.rank ?? null, c.reason, c.mom?.toFixed() ?? null, c.vol?.toFixed() ?? null]),
    cashMom: out.candidates.cashMom?.toFixed() ?? null,
  });
}

describe("a past decision does not move when the future arrives", () => {
  const FROM = D("2026-01-02");
  const TO = D("2026-06-30");
  const DECIDE_SESSION = D("2026-04-17");

  it("survives a corrected bar for the decision session published later", () => {
    const pit = repo();
    seed(pit, FROM, TO);
    const at = addMs(CAL.sessionClose(DECIDE_SESSION), 60 * 60_000);
    const before = fingerprint(decide(pit, at));

    // A correction that would have flipped the ranking, published a week after the decision.
    appendBar(pit, "CCC", DECIDE_SESSION, N("100000"), { availableAt: utc("2026-04-24T20:30:00Z"), locatorSuffix: "#corrected" });
    expect(fingerprint(decide(pit, at))).toBe(before);

    // Read after the correction became available and the same code does see it. The corrected close sits
    // inside the volatility window (not at a momentum endpoint), so it shows up as an enormous vol estimate
    // and CCC drops out of the book on the size rule rather than the ranking.
    const laterAt = utc("2026-04-27T20:30:00Z");
    const withCorrection = decide(pit, laterAt).fs.features.get("CCC")?.vol;
    const beforeCorrection = decide(pit, at).fs.features.get("CCC")?.vol;
    expect(withCorrection).toBeDefined();
    expect(beforeCorrection).toBeDefined();
    if (withCorrection && beforeCorrection) {
      expect(withCorrection.gt(beforeCorrection.times(N("100")))).toBe(true);
    }
  });

  it("survives a dividend announced after the decision", () => {
    const pit = repo();
    seed(pit, FROM, TO);
    const at = addMs(CAL.sessionClose(DECIDE_SESSION), 60 * 60_000);
    const before = fingerprint(decide(pit, at));

    const exDate = D("2026-04-15");
    pit.append(
      corporateActionObservation(
        { kind: "CASH_DIVIDEND", entityId: "BBB", amount: N("5.00"), exDate, payDate: D("2026-05-01"), qualified: true },
        {
          sourceLocator: "fixture/late-dividend",
          // Announced a fortnight after the ex-date: a real late record, correctly dated.
          availableAt: utc("2026-04-29T13:00:00Z"),
          ingestedAt: INGESTED,
          rawContentHash: `sha256:${sha256Hex("late-dividend")}`,
          adapterVersion: ADAPTER,
          parserVersion: ADAPTER,
        },
      ),
    );
    expect(fingerprint(decide(pit, at))).toBe(before);
    // Once available, the dividend does lift BBB's total-return momentum.
    const after = decide(pit, utc("2026-05-04T20:30:00Z"));
    const momBefore = decide(pit, at).fs.features.get("BBB")?.mom;
    const momAfter = after.fs.features.get("BBB")?.mom;
    expect(momBefore).toBeDefined();
    expect(momAfter).toBeDefined();
    if (momBefore && momAfter) expect(momAfter.eq(momBefore)).toBe(false);
  });

  it("survives every later session being appended", () => {
    const pit = repo();
    seed(pit, FROM, D("2026-04-17"));
    const at = addMs(CAL.sessionClose(DECIDE_SESSION), 60 * 60_000);
    const before = fingerprint(decide(pit, at));
    // The rest of the half-year arrives.
    const rest = CAL.sessionDates(D("2026-04-20"), TO);
    const startIndex = CAL.sessionDates(FROM, TO).indexOf(D("2026-04-20"));
    rest.forEach((session, k) => {
      appendBar(pit, "AAA", session, N("100").times(N("1.004").pow(startIndex + k)));
      appendBar(pit, "BBB", session, N("50").times(N("1.002").pow(startIndex + k)));
      appendBar(pit, "CCC", session, N("80").times(N("1.001").pow(startIndex + k)));
      appendBar(pit, "BIL", session, N("91").times(N("1.00008").pow(startIndex + k)));
    });
    expect(fingerprint(decide(pit, at))).toBe(before);
  });

  it("is identical whether the store holds only the past or the whole history", () => {
    const past = repo();
    seed(past, FROM, DECIDE_SESSION);
    const whole = repo();
    seed(whole, FROM, TO);
    const at = addMs(CAL.sessionClose(DECIDE_SESSION), 60 * 60_000);
    expect(fingerprint(decide(whole, at))).toBe(fingerprint(decide(past, at)));
  });

  it("passes an independent leakage audit at every weekly decision in the window", () => {
    const pit = repo();
    const sessions = seed(pit, FROM, TO);
    const auditor = auditReads(pit, { defaultDelayMs: defaultProcessingDelayMs });
    const weekly = sessions.filter((s, i) => {
      const next = sessions[i + 1];
      if (next === undefined) return true;
      return new Date(`${next}T00:00:00Z`).getUTCDay() < new Date(`${s}T00:00:00Z`).getUTCDay();
    });
    for (const session of weekly) {
      const at = addMs(CAL.sessionClose(session), 60 * 60_000);
      computeFeatures({ pit: auditor, calendar: CAL }, { riskEntities: RISK, cashEntityId: "BIL", decisionAt: at, params: PARAMS });
    }
    const report = auditor.report();
    expect(report.violations).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.minMarginMs).toBeGreaterThanOrEqual(0);
  });
});

describe("a decision refuses data it cannot line up in time", () => {
  it("excludes a member whose feed is behind the rest of the cross-section", () => {
    // CCC's feed stops a week early: everyone else has a current bar, CCC does not.
    const sessions = CAL.sessionDates(D("2026-01-02"), D("2026-06-30"));
    const stop = D("2026-05-08");
    const decideSession = D("2026-05-15");
    const fresh = repo();
    for (const [entityId, start, step] of [
      ["AAA", "100", "1.004"],
      ["BBB", "50", "1.002"],
      ["BIL", "91", "1.00008"],
    ] as [string, string, string][]) {
      sessions.forEach((session, i) => {
        appendBar(fresh, entityId, session, N(start).times(N(step).pow(i)));
      });
    }
    sessions
      .filter((s) => s <= stop)
      .forEach((session, i) => {
        appendBar(fresh, "CCC", session, N("80").times(N("1.001").pow(i)));
      });

    const at = addMs(CAL.sessionClose(decideSession), 60 * 60_000);
    const out = decide(fresh, at);
    expect(out.fs.anchorSession).toBe(decideSession);
    expect(out.fs.features.get("CCC")?.reasons).toContain(STALE_ANCHOR);
    expect(out.candidates.selected).not.toContain("CCC");
    expect(out.candidates.candidates.find((c) => c.entityId === "CCC")?.reason).toBe("NO_FEATURES");
  });

  it("holds nothing at all when no member has enough history yet", () => {
    const pit = repo();
    const sessions = seed(pit, D("2026-01-02"), D("2026-06-30"));
    const early = sessions[3];
    if (early === undefined) throw new Error("fixture too short");
    const out = decide(pit, addMs(CAL.sessionClose(early), 60 * 60_000));
    expect(out.candidates.selected).toEqual([]);
    for (const c of out.candidates.candidates) expect(c.reason).toBe("NO_FEATURES");
  });

  it("makes the same decision from the same anchor whichever instant inside the window it is taken at", () => {
    const pit = repo();
    seed(pit, D("2026-01-02"), D("2026-06-30"));
    const session = D("2026-04-17");
    // One hour after the close, and again three hours later: the same bars are available, so the same answer.
    const a = decide(pit, addMs(CAL.sessionClose(session), 60 * 60_000));
    const b = decide(pit, addMs(CAL.sessionClose(session), 4 * 60 * 60_000));
    expect(fingerprint(b)).toBe(fingerprint(a));
    expect(ONE.plus(ZERO).eq(ONE)).toBe(true);
  });
});
