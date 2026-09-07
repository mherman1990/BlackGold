import { describe, expect, it } from "vitest";
import { Dec, ONE, ZERO, isoDate, sumDec } from "@blackgold/shared";
import {
  constructTargets,
  PORTFOLIO_CONSTRUCTION_VERSION,
  rebalanceOrders,
  shareTargets,
  SizingInputError,
  sizingParamsFromCharter,
  type SizingParams,
} from "../src/strategy/construct.ts";
import { portfolioVolatility, type CovarianceWindow } from "../src/strategy/features.ts";

const N = (s: string): Dec => new Dec(s);
const PARAMS: SizingParams = { maxWeightPerEtf: N("0.20"), minCashWeight: N("0.02"), annualVolatilityTarget: N("0.10"), maxGrossExposure: N("0.98") };
const TOL = N("1e-20");
const close = (a: Dec, b: Dec): boolean => a.minus(b).abs().lt(TOL);

/** A diagonal covariance window: zero correlation, so sigma_p = sqrt(sum w_i^2 vol_i^2). */
function diagonalCov(vols: Record<string, string>): CovarianceWindow {
  const entities = Object.keys(vols);
  return {
    entities,
    sessions: [isoDate("2026-05-15")],
    matrix: entities.map((a) => entities.map((b) => (a === b ? N(vols[a] ?? "0").pow(2) : ZERO))),
  };
}

/** A covariance window where every pair correlates perfectly, so sigma_p = sum w_i vol_i. */
function perfectlyCorrelatedCov(vols: Record<string, string>): CovarianceWindow {
  const entities = Object.keys(vols);
  return {
    entities,
    sessions: [isoDate("2026-05-15")],
    matrix: entities.map((a) => entities.map((b) => N(vols[a] ?? "0").times(N(vols[b] ?? "0")))),
  };
}

function volMap(vols: Record<string, string>): Map<string, Dec> {
  return new Map(Object.entries(vols).map(([k, v]) => [k, N(v)]));
}

describe("inverse-volatility weighting", () => {
  it("weights each name inversely to its own volatility", () => {
    const vols = { A: "0.10", B: "0.20", C: "0.40" };
    const t = constructTargets({ selected: ["A", "B", "C"], volatilities: volMap(vols), covariance: diagonalCov(vols), params: PARAMS });
    // 1/0.1 : 1/0.2 : 1/0.4 = 10 : 5 : 2.5 -> 4/7 : 2/7 : 1/7
    expect(close(t.rawWeights.get("A") ?? ZERO, N("4").div(7))).toBe(true);
    expect(close(t.rawWeights.get("B") ?? ZERO, N("2").div(7))).toBe(true);
    expect(close(t.rawWeights.get("C") ?? ZERO, ONE.div(7))).toBe(true);
    expect(close(sumDec(t.rawWeights.values()), ONE)).toBe(true);
    expect(t.portfolioConstructionVersion).toBe(PORTFOLIO_CONSTRUCTION_VERSION);
  });

  it("is invariant to momentum magnitude: sizing sees only volatility and covariance", () => {
    // The construct signature admits no momentum at all. This test pins that: two books with the same
    // volatilities in a different selection order produce the same weights per entity.
    const vols = { A: "0.12", B: "0.18", C: "0.30" };
    const forward = constructTargets({ selected: ["A", "B", "C"], volatilities: volMap(vols), covariance: diagonalCov(vols), params: PARAMS });
    const reversed = constructTargets({ selected: ["C", "B", "A"], volatilities: volMap(vols), covariance: diagonalCov(vols), params: PARAMS });
    for (const id of ["A", "B", "C"]) expect(close(forward.weights.get(id) ?? ZERO, reversed.weights.get(id) ?? ZERO)).toBe(true);
    expect(close(forward.cashWeight, reversed.cashWeight)).toBe(true);
  });

  it("drops a name with no usable volatility rather than sizing it blind", () => {
    const t = constructTargets({
      selected: ["A", "B", "MISSING", "ZEROVOL"],
      volatilities: new Map([
        ["A", N("0.10")],
        ["B", N("0.20")],
        ["ZEROVOL", ZERO],
      ]),
      covariance: diagonalCov({ A: "0.10", B: "0.20" }),
      params: PARAMS,
    });
    expect(t.unsized).toEqual(["MISSING", "ZEROVOL"]);
    expect(t.weights.has("MISSING")).toBe(false);
    expect(t.weights.has("ZEROVOL")).toBe(false);
    expect(t.notes.join(" ")).toContain("MISSING");
  });

  it("holds only cash for an empty book", () => {
    const t = constructTargets({ selected: [], volatilities: new Map(), covariance: undefined, params: PARAMS });
    expect(t.weights.size).toBe(0);
    expect(t.cashWeight.eq(ONE)).toBe(true);
  });
});

describe("per-ETF cap", () => {
  it("caps a dominant name and redistributes pro rata to the others", () => {
    // A has one-tenth the volatility of the others, so its raw weight (5/7) is far above the 20% cap.
    // Redistributing 18/35 pro rata over the four open names lifts each from 1/14 to exactly 1/5, so the
    // capped book is five equal 20% legs summing to 1. Diagonal covariance puts sigma_p at about 8%, under
    // the 10% target, so nothing is scaled for volatility and the 98% invested ceiling is what binds:
    // each leg lands at 0.98 / 5 = 0.196.
    const vols = { A: "0.02", B: "0.20", C: "0.20", D: "0.20", E: "0.20" };
    const t = constructTargets({ selected: ["A", "B", "C", "D", "E"], volatilities: volMap(vols), covariance: diagonalCov(vols), params: PARAMS });
    expect(close(t.rawWeights.get("A") ?? ZERO, N("5").div(7))).toBe(true);
    expect(t.exAnteVolatility.lt(PARAMS.annualVolatilityTarget)).toBe(true);
    expect(t.volatilityScale.eq(ONE)).toBe(true);
    for (const id of ["A", "B", "C", "D", "E"]) expect(close(t.weights.get(id) ?? ZERO, N("0.196"))).toBe(true);
    expect(close(sumDec(t.weights.values()), N("0.98"))).toBe(true);
    expect(close(t.cashWeight, N("0.02"))).toBe(true);
  });

  it("never exceeds the cap after redistribution, at any book size", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const vols: Record<string, string> = {};
      for (let i = 0; i < n; i++) vols[`E${i}`] = i === 0 ? "0.01" : "0.30";
      const t = constructTargets({ selected: Object.keys(vols), volatilities: volMap(vols), covariance: diagonalCov(vols), params: PARAMS });
      for (const [, w] of t.weights) expect(w.lte(PARAMS.maxWeightPerEtf)).toBe(true);
    }
  });

  it("leaves unplaceable weight in cash when a single name would need more than the cap", () => {
    // One holding, cap 20%: 80% cannot be placed and must sit in cash, not be forced into the position.
    const t = constructTargets({ selected: ["A"], volatilities: volMap({ A: "0.10" }), covariance: diagonalCov({ A: "0.10" }), params: PARAMS });
    expect(close(t.weights.get("A") ?? ZERO, N("0.20"))).toBe(true);
    expect(close(t.cashWeight, N("0.80"))).toBe(true);
    expect(t.notes.join(" ")).toContain("unplaceable");
  });

  it("rejects a non-positive cap", () => {
    expect(() => constructTargets({ selected: ["A"], volatilities: volMap({ A: "0.1" }), covariance: undefined, params: { ...PARAMS, maxWeightPerEtf: ZERO } })).toThrow(
      SizingInputError,
    );
  });
});

describe("volatility scaling", () => {
  it("scales the book down to the target when ex-ante volatility exceeds it", () => {
    // Perfectly correlated names at 40% vol: the capped book sums to 1, so sigma_p = 0.40.
    const vols = { A: "0.40", B: "0.40", C: "0.40", D: "0.40", E: "0.40" };
    const t = constructTargets({ selected: ["A", "B", "C", "D", "E"], volatilities: volMap(vols), covariance: perfectlyCorrelatedCov(vols), params: PARAMS });
    expect(close(t.exAnteVolatility, N("0.40"))).toBe(true);
    expect(close(t.volatilityScale, N("0.25"))).toBe(true);
    expect(close(sumDec(t.weights.values()), N("0.25"))).toBe(true);
    expect(close(t.cashWeight, N("0.75"))).toBe(true);
  });

  it("never scales up: a calm book stops at the invested ceiling, not at the target", () => {
    const vols = { A: "0.02", B: "0.02", C: "0.02", D: "0.02", E: "0.02" };
    const t = constructTargets({ selected: ["A", "B", "C", "D", "E"], volatilities: volMap(vols), covariance: perfectlyCorrelatedCov(vols), params: PARAMS });
    expect(t.exAnteVolatility.lt(PARAMS.annualVolatilityTarget)).toBe(true);
    expect(t.volatilityScale.eq(ONE)).toBe(true);
    expect(close(sumDec(t.weights.values()), N("0.98"))).toBe(true);
  });

  it("keeps the realized ex-ante volatility of the scaled book at the target", () => {
    const vols = { A: "0.30", B: "0.25", C: "0.35" };
    const cov = perfectlyCorrelatedCov(vols);
    const t = constructTargets({ selected: ["A", "B", "C"], volatilities: volMap(vols), covariance: cov, params: PARAMS });
    // Perfect correlation makes sigma linear in the weights, so scaling by k lands exactly on the target.
    const scaled = portfolioVolatility(cov, t.weights);
    expect(close(scaled, PARAMS.annualVolatilityTarget)).toBe(true);
  });

  it("holds only the cash floor when no covariance window exists", () => {
    const t = constructTargets({ selected: ["A", "B"], volatilities: volMap({ A: "0.1", B: "0.2" }), covariance: undefined, params: PARAMS });
    expect(t.volatilityScale.eq(ONE)).toBe(true);
    expect(t.notes.join(" ")).toContain("no covariance window");
  });

  it("rejects a non-positive volatility target", () => {
    expect(() => constructTargets({ selected: [], volatilities: new Map(), covariance: undefined, params: { ...PARAMS, annualVolatilityTarget: ZERO } })).toThrow(
      SizingInputError,
    );
  });
});

describe("cash floor and gross ceiling", () => {
  it("keeps at least the minimum cash weight whatever the volatility estimate", () => {
    for (const vol of ["0.001", "0.01", "0.05", "0.10", "0.50"]) {
      const vols = { A: vol, B: vol, C: vol, D: vol, E: vol };
      const t = constructTargets({ selected: ["A", "B", "C", "D", "E"], volatilities: volMap(vols), covariance: perfectlyCorrelatedCov(vols), params: PARAMS });
      expect(t.cashWeight.gte(PARAMS.minCashWeight)).toBe(true);
      expect(sumDec(t.weights.values()).lte(ONE.minus(PARAMS.minCashWeight))).toBe(true);
    }
  });

  it("respects a gross-exposure ceiling tighter than the cash floor", () => {
    const vols = { A: "0.01", B: "0.01", C: "0.01", D: "0.01", E: "0.01" };
    const t = constructTargets({
      selected: ["A", "B", "C", "D", "E"],
      volatilities: volMap(vols),
      covariance: perfectlyCorrelatedCov(vols),
      params: { ...PARAMS, maxGrossExposure: N("0.60") },
    });
    expect(close(sumDec(t.weights.values()), N("0.60"))).toBe(true);
  });

  it("rejects an out-of-range cash floor or gross ceiling", () => {
    expect(() => constructTargets({ selected: [], volatilities: new Map(), covariance: undefined, params: { ...PARAMS, minCashWeight: ONE } })).toThrow(SizingInputError);
    expect(() => constructTargets({ selected: [], volatilities: new Map(), covariance: undefined, params: { ...PARAMS, maxGrossExposure: N("1.5") } })).toThrow(
      SizingInputError,
    );
  });
});

describe("shareTargets", () => {
  it("floors to whole shares and leaves the rounding residual in cash", () => {
    const { targets, unpriced } = shareTargets({
      nav: N("10000"),
      weights: new Map([
        ["A", N("0.20")],
        ["B", N("0.30")],
      ]),
      prices: new Map([
        ["A", N("301")],
        ["B", N("77")],
      ]),
    });
    expect(unpriced).toEqual([]);
    // 10000 x 0.20 / 301 = 6.64 -> 6 shares; 10000 x 0.30 / 77 = 38.96 -> 38 shares.
    expect(targets[0]?.targetShares.eq(N("6"))).toBe(true);
    expect(targets[1]?.targetShares.eq(N("38"))).toBe(true);
    for (const t of targets) expect(t.achievedWeight.lte(t.targetWeight)).toBe(true);
  });

  it("names an unpriced entity instead of sizing it", () => {
    const { targets, unpriced } = shareTargets({ nav: N("10000"), weights: new Map([["A", N("0.2")]]), prices: new Map([["A", ZERO]]) });
    expect(targets).toEqual([]);
    expect(unpriced).toEqual(["A"]);
  });

  it("rejects a non-positive NAV", () => {
    expect(() => shareTargets({ nav: ZERO, weights: new Map(), prices: new Map() })).toThrow(SizingInputError);
  });
});

describe("rebalanceOrders", () => {
  const prices = new Map([
    ["A", N("100")],
    ["B", N("100")],
  ]);

  it("does not trade a line inside the band", () => {
    // Holding 19 shares against a 20-share target at 100 on a 10000 NAV is a 1.0-point gap: inside a 2.0 band.
    const orders = rebalanceOrders({
      nav: N("10000"),
      targets: [{ entityId: "A", targetWeight: N("0.20"), targetShares: N("20"), achievedWeight: N("0.20"), price: N("100") }],
      current: new Map([["A", N("19")]]),
      prices,
      bandPctPoints: N("2.0"),
    });
    expect(orders).toEqual([]);
  });

  it("trades a line outside the band", () => {
    const orders = rebalanceOrders({
      nav: N("10000"),
      targets: [{ entityId: "A", targetWeight: N("0.20"), targetShares: N("20"), achievedWeight: N("0.20"), price: N("100") }],
      current: new Map([["A", N("15")]]),
      prices,
      bandPctPoints: N("2.0"),
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.deltaShares.eq(N("5"))).toBe(true);
    expect(orders[0]?.reason).toBe("BAND_EXCEEDED");
    expect(orders[0]?.gapPctPoints.eq(N("5"))).toBe(true);
  });

  it("always trades an entry however small", () => {
    const orders = rebalanceOrders({
      nav: N("1000000"),
      targets: [{ entityId: "A", targetWeight: N("0.0001"), targetShares: ONE, achievedWeight: N("0.0001"), price: N("100") }],
      current: new Map(),
      prices,
      bandPctPoints: N("2.0"),
    });
    expect(orders[0]?.reason).toBe("ENTRY");
  });

  it("always trades an exit: the band never keeps a position the rules removed", () => {
    const orders = rebalanceOrders({
      nav: N("1000000"),
      targets: [],
      current: new Map([["B", ONE]]),
      prices,
      bandPctPoints: N("50"),
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.entityId).toBe("B");
    expect(orders[0]?.reason).toBe("EXIT");
    expect(orders[0]?.deltaShares.eq(ONE.negated())).toBe(true);
  });

  it("is ordered by entity id so a decision record is reproducible", () => {
    const orders = rebalanceOrders({
      nav: N("10000"),
      targets: [
        { entityId: "B", targetWeight: N("0.20"), targetShares: N("20"), achievedWeight: N("0.20"), price: N("100") },
        { entityId: "A", targetWeight: N("0.20"), targetShares: N("20"), achievedWeight: N("0.20"), price: N("100") },
      ],
      current: new Map(),
      prices,
      bandPctPoints: N("2.0"),
    });
    expect(orders.map((o) => o.entityId)).toEqual(["A", "B"]);
  });
});

describe("sizingParamsFromCharter", () => {
  it("reads the registered caps out of the charter", async () => {
    const { loadCharterFile } = await import("../src/strategy/charter.ts");
    const { fileURLToPath } = await import("node:url");
    const { charter } = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url)));
    const p = sizingParamsFromCharter(charter);
    expect(p.maxWeightPerEtf.eq(N("0.20"))).toBe(true);
    expect(p.minCashWeight.eq(N("0.02"))).toBe(true);
    expect(p.annualVolatilityTarget.eq(N("0.10"))).toBe(true);
  });
});
