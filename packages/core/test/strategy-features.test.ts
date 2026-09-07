import { describe, expect, it } from "vitest";
import { Dec, ONE, utc } from "@blackgold/shared";
import {
  computeFeatures,
  featureParamsFromCharter,
  FEATURES_VERSION,
  INSUFFICIENT_HISTORY,
  portfolioVolatility,
  STALE_ANCHOR,
  requiredHistorySessions,
  type FeatureParams,
} from "../src/strategy/features.ts";
import { buildMarket, D, N, pathClose, type PricePath } from "./strategy-fixture.ts";

/** Small windows keep the fixture short while exercising the same code paths as the charter's 252/200/63. */
const SMALL: FeatureParams = {
  momentumLookbackSessions: 20,
  momentumSkipSessions: 4,
  trendSmaSessions: 10,
  volatilitySessions: 15,
  advSessions: 5,
  minAdvUsd: N("1000000"),
};

const RISERS: PricePath[] = [
  { entityId: "AAA", start: N("100"), perSession: N("1.004"), volumeShares: 2_000_000n, wobble: N("0.002") },
  { entityId: "BBB", start: N("50"), perSession: N("1.002"), volumeShares: 3_000_000n, wobble: N("0.006") },
  { entityId: "CCC", start: N("80"), perSession: N("0.998"), volumeShares: 1_500_000n, wobble: N("0.003") },
  { entityId: "BIL", start: N("91"), perSession: N("1.00008"), volumeShares: 900_000n },
];

/**
 * One fixture market for the whole file. `computeFeatures` only reads the store, so sharing it cannot couple
 * these tests, and rebuilding it per test re-inserted ~500 observations each time — which is what made this
 * suite slow enough to time out on a CI runner. Tests that need a *different* market (a feed with a hole,
 * a stale bar) still call `buildMarket` directly.
 */
let sharedMarket: ReturnType<typeof buildMarket> | undefined;
function market() {
  sharedMarket ??= buildMarket({ paths: RISERS, from: D("2026-01-02"), to: D("2026-06-30") });
  return sharedMarket;
}

describe("computeFeatures", () => {
  it("anchors the decision to the last session at or before the decision instant", () => {
    const m = market();
    const session = D("2026-04-17");
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA", "BBB", "CCC"], cashEntityId: "BIL", decisionAt: m.decisionAt(session), params: SMALL },
    );
    expect(fs.decisionSession).toBe(session);
    expect(fs.featuresVersion).toBe(FEATURES_VERSION);
    expect(fs.features.get("AAA")?.session).toBe(session);
  });

  it("computes momentum as the total return from t-lookback to t-skip", () => {
    const m = market();
    const session = D("2026-04-17");
    const idx = m.sessions.indexOf(session);
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA"], cashEntityId: "BIL", decisionAt: m.decisionAt(session), params: SMALL },
    );
    const path = RISERS[0];
    if (!path) throw new Error("fixture path missing");
    // No dividends or splits in this path, so the total-return ratio is the raw close ratio.
    const expected = pathClose(path, idx - SMALL.momentumSkipSessions).div(pathClose(path, idx - SMALL.momentumLookbackSessions)).minus(ONE);
    const mom = fs.features.get("AAA")?.mom;
    expect(mom).toBeDefined();
    expect(mom?.minus(expected).abs().lt(new Dec("1e-24"))).toBe(true);
  });

  it("ranks a steady riser above a steady faller and puts the cash hurdle between them", () => {
    const m = market();
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA", "BBB", "CCC"], cashEntityId: "BIL", decisionAt: m.decisionAt(D("2026-05-15")), params: SMALL },
    );
    const mom = (e: string): Dec => {
      const v = fs.features.get(e)?.mom;
      if (!v) throw new Error(`no momentum for ${e}`);
      return v;
    };
    expect(mom("AAA").gt(mom("BBB"))).toBe(true);
    expect(mom("BBB").gt(mom("CCC"))).toBe(true);
    expect(fs.cashMom).toBeDefined();
    expect(mom("AAA").gt(fs.cashMom ?? ONE)).toBe(true);
    expect(mom("CCC").lt(fs.cashMom ?? ONE.negated())).toBe(true);
  });

  it("sets the trend flag from the adjusted close against its own moving average", () => {
    const m = market();
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA", "CCC"], cashEntityId: "BIL", decisionAt: m.decisionAt(D("2026-05-15")), params: SMALL },
    );
    expect(fs.features.get("AAA")?.trend).toBe(true);
    expect(fs.features.get("CCC")?.trend).toBe(false);
  });

  it("computes average dollar volume from raw closes and volumes, never adjusted ones", () => {
    const m = market();
    const session = D("2026-05-15");
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["BBB"], cashEntityId: "BIL", decisionAt: m.decisionAt(session), params: SMALL },
    );
    const idx = m.sessions.indexOf(session);
    const path = RISERS[1];
    if (!path) throw new Error("fixture path missing");
    let sum = new Dec(0);
    for (let i = idx - SMALL.advSessions + 1; i <= idx; i++) sum = sum.plus(pathClose(path, i).times(new Dec(path.volumeShares.toString())));
    const expected = sum.div(SMALL.advSessions);
    expect(fs.features.get("BBB")?.adv?.minus(expected).abs().lt(new Dec("1e-18"))).toBe(true);
    expect(fs.features.get("BBB")?.px?.eq(pathClose(path, idx))).toBe(true);
  });

  it("makes vol the square root of the covariance diagonal over the identical window", () => {
    const m = market();
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA", "BBB", "CCC"], cashEntityId: "BIL", decisionAt: m.decisionAt(D("2026-05-15")), params: SMALL },
    );
    const cov = fs.covariance;
    expect(cov).toBeDefined();
    if (!cov) return;
    expect(cov.sessions).toHaveLength(SMALL.volatilitySessions);
    for (let i = 0; i < cov.entities.length; i++) {
      const e = cov.entities[i];
      const variance = cov.matrix[i]?.[i];
      const vol = e === undefined ? undefined : fs.features.get(e)?.vol;
      expect(vol).toBeDefined();
      expect(variance).toBeDefined();
      if (vol && variance) expect(vol.times(vol).minus(variance).abs().lt(new Dec("1e-24"))).toBe(true);
    }
    // A wobblier path has the higher volatility: BBB wobbles 60 bps, AAA 20 bps.
    const volA = fs.features.get("AAA")?.vol;
    const volB = fs.features.get("BBB")?.vol;
    if (volA && volB) expect(volB.gt(volA)).toBe(true);
  });

  it("produces a symmetric covariance matrix", () => {
    const m = market();
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA", "BBB", "CCC"], cashEntityId: "BIL", decisionAt: m.decisionAt(D("2026-05-15")), params: SMALL },
    );
    const cov = fs.covariance;
    if (!cov) throw new Error("no covariance window");
    for (let a = 0; a < cov.entities.length; a++) {
      for (let b = 0; b < cov.entities.length; b++) {
        expect(cov.matrix[a]?.[b]?.eq(cov.matrix[b]?.[a] ?? new Dec(-1))).toBe(true);
      }
    }
  });

  it("refuses to compute a short window instead of shortening it", () => {
    const m = market();
    // The 6th session cannot support a 20-session momentum lookback.
    const early = m.sessions[5];
    if (early === undefined) throw new Error("fixture too short");
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA"], cashEntityId: "BIL", decisionAt: m.decisionAt(early), params: SMALL },
    );
    const f = fs.features.get("AAA");
    expect(f?.mom).toBeUndefined();
    expect(f?.trend).toBeUndefined();
    expect(f?.reasons).toContain(INSUFFICIENT_HISTORY);
  });

  it("fails closed on an entity priced behind the rest of the universe rather than ranking stale prices", () => {
    const m = buildMarket({
      paths: RISERS,
      from: D("2026-01-02"),
      to: D("2026-06-30"),
      omitSessions: { CCC: [D("2026-05-11"), D("2026-05-12"), D("2026-05-13"), D("2026-05-14"), D("2026-05-15")] },
    });
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA", "CCC"], cashEntityId: "BIL", decisionAt: m.decisionAt(D("2026-05-15")), params: SMALL },
    );
    // AAA still has 2026-05-15, so the anchor stays current and CCC (last bar 2026-05-08) is the odd one out.
    expect(fs.anchorSession).toBe(D("2026-05-15"));
    expect(fs.features.get("AAA")?.mom).toBeDefined();
    const f = fs.features.get("CCC");
    expect(f?.session).toBe(D("2026-05-08"));
    expect(f?.reasons).toContain(STALE_ANCHOR);
    // Nothing is left for a downstream rule to use by accident.
    expect(f?.mom).toBeUndefined();
    expect(f?.trend).toBeUndefined();
    expect(f?.vol).toBeUndefined();
    expect(f?.px).toBeUndefined();
    expect(fs.covariance?.entities).not.toContain("CCC");
  });

  it("moves the whole cross-section back together when no bar has published yet", () => {
    const m = market();
    const session = D("2026-05-15");
    const tooEarly = utc(Date.parse(m.calendar.sessionClose(session)) + 60_000);
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA", "BBB", "CCC"], cashEntityId: "BIL", decisionAt: tooEarly, params: SMALL },
    );
    expect(fs.decisionSession).toBe(session);
    expect(fs.anchorSession).toBe(D("2026-05-14"));
    // A shared publication lag is not a data fault: every member is priced and none is marked stale.
    for (const e of ["AAA", "BBB", "CCC"]) {
      expect(fs.features.get(e)?.reasons).not.toContain(STALE_ANCHOR);
      expect(fs.features.get(e)?.mom).toBeDefined();
    }
  });

  it("excludes a bar published after the decision instant", () => {
    const m = market();
    const session = D("2026-05-15");
    // One minute after the close, before the 30-minute publication delay has elapsed.
    const tooEarly = utc(Date.parse(m.calendar.sessionClose(session)) + 60_000);
    const fs = computeFeatures({ pit: m.pit, calendar: m.calendar }, { riskEntities: ["AAA"], cashEntityId: "BIL", decisionAt: tooEarly, params: SMALL });
    expect(fs.decisionSession).toBe(session);
    // The session's own bar is not yet available, so the anchor falls back to the prior session.
    expect(fs.anchorSession).toBe(D("2026-05-14"));
    expect(fs.features.get("AAA")?.session).toBe(D("2026-05-14"));
  });

  it("leaves a stale bar out of the return series but keeps the entity priced", () => {
    const stale = D("2026-05-14");
    const m = buildMarket({ paths: RISERS, from: D("2026-01-02"), to: D("2026-06-30"), staleSessions: { AAA: [stale] } });
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA", "BBB"], cashEntityId: "BIL", decisionAt: m.decisionAt(D("2026-05-15")), params: SMALL },
    );
    const f = fs.features.get("AAA");
    expect(f?.session).toBe(D("2026-05-15"));
    expect(f?.vol).toBeDefined();
    expect(fs.covariance?.sessions).not.toContain(stale);
  });
});

describe("portfolioVolatility", () => {
  it("returns the entity volatility for a single fully weighted holding", () => {
    const m = market();
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA", "BBB", "CCC"], cashEntityId: "BIL", decisionAt: m.decisionAt(D("2026-05-15")), params: SMALL },
    );
    const cov = fs.covariance;
    const volA = fs.features.get("AAA")?.vol;
    if (!cov || !volA) throw new Error("fixture did not produce a covariance window");
    const sigma = portfolioVolatility(cov, new Map([["AAA", ONE]]));
    expect(sigma.minus(volA).abs().lt(new Dec("1e-24"))).toBe(true);
  });

  it("is zero for an empty book and monotone in weight", () => {
    const m = market();
    const fs = computeFeatures(
      { pit: m.pit, calendar: m.calendar },
      { riskEntities: ["AAA", "BBB", "CCC"], cashEntityId: "BIL", decisionAt: m.decisionAt(D("2026-05-15")), params: SMALL },
    );
    const cov = fs.covariance;
    if (!cov) throw new Error("no covariance window");
    expect(portfolioVolatility(cov, new Map()).isZero()).toBe(true);
    const half = portfolioVolatility(cov, new Map([["AAA", new Dec("0.5")]]));
    const full = portfolioVolatility(cov, new Map([["AAA", ONE]]));
    expect(full.gt(half)).toBe(true);
  });
});

describe("requiredHistorySessions", () => {
  it("takes the longest window plus the extra point a return needs", () => {
    expect(requiredHistorySessions(SMALL)).toBe(SMALL.momentumLookbackSessions + 1);
    expect(requiredHistorySessions({ ...SMALL, volatilitySessions: 400 })).toBe(401);
  });
});

describe("featureParamsFromCharter", () => {
  it("reads the registered windows straight out of the charter", async () => {
    const { loadCharterFile } = await import("../src/strategy/charter.ts");
    const { fileURLToPath } = await import("node:url");
    const { charter } = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url)));
    expect(featureParamsFromCharter(charter)).toEqual({
      momentumLookbackSessions: 252,
      momentumSkipSessions: 21,
      trendSmaSessions: 200,
      volatilitySessions: 63,
      advSessions: 20,
      minAdvUsd: new Dec("50000000"),
    });
  });
});
