import { Dec, ONE, ZERO, sumDec } from "@blackgold/shared";
import type { CovarianceWindow } from "./features.ts";
import { portfolioVolatility } from "./features.ts";
import type { Charter } from "./charter.ts";

/**
 * Deterministic portfolio construction and sizing (ALPHA_CHARTER.md section 9).
 *
 * Signal strength enters size only through `vol_i` and the covariance matrix. Momentum magnitude never does,
 * and no model output of any kind can reach this function: its whole input surface is a selected entity list,
 * a volatility estimate per entity, a covariance window, and the charter's frozen caps. That is what makes
 * "sizing is provably invariant to signal magnitude" a property test rather than a claim.
 *
 * Every step can only shrink exposure. The per-ETF cap redistributes to a fixpoint, the volatility target
 * scales down and never up (`k = min(1, target / sigma_p)`), and the cash floor is enforced last.
 */

export const PORTFOLIO_CONSTRUCTION_VERSION = 1;

export type SizingParams = {
  maxWeightPerEtf: Dec;
  minCashWeight: Dec;
  annualVolatilityTarget: Dec;
  maxGrossExposure: Dec;
};

export function sizingParamsFromCharter(c: Charter): SizingParams {
  return {
    maxWeightPerEtf: new Dec(c.sizing.max_weight_per_etf),
    minCashWeight: new Dec(c.sizing.min_cash_weight),
    annualVolatilityTarget: new Dec(c.sizing.annual_volatility_target),
    maxGrossExposure: new Dec(c.posture.max_gross_exposure),
  };
}

export type TargetWeights = {
  /** Risk-ETF weights as fractions of NAV, keyed by entity id. Never negative, never above the cap. */
  weights: Map<string, Dec>;
  /** `1 - sum(weights)`, held in the cash leg. Never below `minCashWeight`. */
  cashWeight: Dec;
  /** Inverse-volatility weights before any cap, target, or floor. Diagnostic only. */
  rawWeights: Map<string, Dec>;
  /** Ex-ante annualized volatility of the capped, pre-scaling book. */
  exAnteVolatility: Dec;
  /** `k = min(1, target / sigma_p)`, or 1 when volatility could not be estimated. */
  volatilityScale: Dec;
  /** Entities dropped because they had no usable volatility estimate. */
  unsized: string[];
  notes: string[];
  portfolioConstructionVersion: number;
};

export class SizingInputError extends Error {
  constructor(detail: string) {
    super(`Sizing input error: ${detail}`);
    this.name = "SizingInputError";
  }
}

export type ConstructInput = {
  /** Entities to hold, in rank order. Ranking affects nothing below; it is used only for stable reporting. */
  selected: readonly string[];
  /** Annualized volatility per entity. An entity with no positive estimate cannot be sized. */
  volatilities: ReadonlyMap<string, Dec>;
  covariance: CovarianceWindow | undefined;
  params: SizingParams;
};

/**
 * Redistribute weight above `cap` pro rata to the uncapped members, repeating until stable. Terminates: each
 * iteration either caps at least one more member or stops, and there are finitely many members. Residual
 * weight that cannot be placed (every member capped) is returned rather than forced into a position.
 */
function applyCap(weights: Map<string, Dec>, cap: Dec): { weights: Map<string, Dec>; residual: Dec } {
  if (!cap.gt(0)) throw new SizingInputError("maxWeightPerEtf must be positive");
  const out = new Map(weights);
  const capped = new Set<string>();
  for (let guard = 0; guard <= out.size; guard++) {
    let excess = ZERO;
    for (const [id, w] of out) {
      if (w.gt(cap)) {
        excess = excess.plus(w.minus(cap));
        out.set(id, cap);
        capped.add(id);
      }
    }
    if (!excess.gt(0)) return { weights: out, residual: ZERO };
    const openIds = [...out.keys()].filter((id) => !capped.has(id));
    const openTotal = sumDec(openIds.map((id) => out.get(id) ?? ZERO));
    if (openIds.length === 0 || !openTotal.gt(0)) return { weights: out, residual: excess };
    for (const id of openIds) {
      const w = out.get(id) ?? ZERO;
      out.set(id, w.plus(excess.times(w).div(openTotal)));
    }
  }
  return { weights: out, residual: ZERO };
}

/**
 * Build target weights for the selected book.
 *
 * Steps, in the charter's order: inverse-volatility raw weights; the per-ETF cap with pro-rata
 * redistribution to a fixpoint; volatility scaling against the ex-ante portfolio volatility; the cash floor
 * and gross-exposure ceiling. An entity with no positive volatility estimate is dropped and named in
 * `unsized`, because a position whose risk cannot be measured cannot be sized (fail closed).
 */
export function constructTargets(input: ConstructInput): TargetWeights {
  const { params } = input;
  if (params.minCashWeight.isNegative() || params.minCashWeight.gte(ONE)) throw new SizingInputError("minCashWeight must be in [0, 1)");
  if (!params.annualVolatilityTarget.gt(0)) throw new SizingInputError("annualVolatilityTarget must be positive");
  if (!params.maxGrossExposure.gt(0) || params.maxGrossExposure.gt(ONE)) throw new SizingInputError("maxGrossExposure must be in (0, 1]");

  const notes: string[] = [];
  const unsized: string[] = [];
  const sizable: string[] = [];
  for (const id of input.selected) {
    const v = input.volatilities.get(id);
    if (!v?.gt(0)) unsized.push(id);
    else sizable.push(id);
  }
  if (unsized.length > 0) notes.push(`dropped for a missing or non-positive volatility estimate: ${unsized.join(", ")}`);

  const rawWeights = new Map<string, Dec>();
  if (sizable.length > 0) {
    const inverse = sizable.map((id) => ONE.div(input.volatilities.get(id) ?? ONE));
    const total = sumDec(inverse);
    sizable.forEach((id, i) => rawWeights.set(id, (inverse[i] ?? ZERO).div(total)));
  }

  const capped = applyCap(rawWeights, params.maxWeightPerEtf);
  if (capped.residual.gt(0)) notes.push(`per-ETF cap left ${capped.residual.toFixed()} of weight unplaceable; it goes to cash`);

  // Ex-ante volatility of the capped book (which sums to at most 1), then the scale factor.
  let sigma = ZERO;
  let scale = ONE;
  if (input.covariance === undefined) {
    if (sizable.length > 0) notes.push("no covariance window: volatility scaling not applied and the book is held at the cash floor only");
  } else {
    sigma = portfolioVolatility(input.covariance, capped.weights);
    if (sigma.gt(0)) {
      const k = params.annualVolatilityTarget.div(sigma);
      scale = k.lt(ONE) ? k : ONE;
    } else if (sizable.length > 0) {
      notes.push("ex-ante portfolio volatility estimated at zero; scaling left at 1");
    }
  }

  const weights = new Map<string, Dec>();
  for (const [id, w] of capped.weights) weights.set(id, w.times(scale));

  // Cash floor and gross ceiling. Both only shrink: the binding one is applied pro rata across the book.
  const maxInvested = (() => {
    const byCash = ONE.minus(params.minCashWeight);
    return byCash.lt(params.maxGrossExposure) ? byCash : params.maxGrossExposure;
  })();
  let invested = sumDec(weights.values());
  if (invested.gt(maxInvested)) {
    if (!invested.gt(0)) throw new SizingInputError("invested weight is not positive but exceeds the ceiling");
    const shrink = maxInvested.div(invested);
    for (const [id, w] of weights) weights.set(id, w.times(shrink));
    notes.push(`scaled the book by ${shrink.toFixed(8)} to respect the ${maxInvested.toFixed()} invested ceiling`);
    invested = sumDec(weights.values());
  }

  const cashWeight = ONE.minus(invested);
  return {
    weights,
    cashWeight,
    rawWeights,
    exAnteVolatility: sigma,
    volatilityScale: scale,
    unsized,
    notes,
    portfolioConstructionVersion: PORTFOLIO_CONSTRUCTION_VERSION,
  };
}

// ---------------------------------------------------------------------------------------------
// Share quantities and the rebalance band
// ---------------------------------------------------------------------------------------------

export type ShareTarget = {
  entityId: string;
  targetWeight: Dec;
  /** Whole shares at the last unadjusted close. */
  targetShares: Dec;
  /** Weight the whole-share quantity actually represents. */
  achievedWeight: Dec;
  price: Dec;
};

/** Floor every target to whole shares at the raw close; the rounding residual goes to cash. */
export function shareTargets(input: { nav: Dec; weights: ReadonlyMap<string, Dec>; prices: ReadonlyMap<string, Dec> }): { targets: ShareTarget[]; unpriced: string[] } {
  if (!input.nav.gt(0)) throw new SizingInputError("nav must be positive");
  const targets: ShareTarget[] = [];
  const unpriced: string[] = [];
  for (const [entityId, w] of [...input.weights].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const price = input.prices.get(entityId);
    if (!price?.gt(0)) {
      unpriced.push(entityId);
      continue;
    }
    const shares = input.nav.times(w).div(price).floor();
    targets.push({ entityId, targetWeight: w, targetShares: shares, achievedWeight: shares.times(price).div(input.nav), price });
  }
  return { targets, unpriced };
}

export type RebalanceOrder = {
  entityId: string;
  /** Positive to buy, negative to sell. Whole shares. */
  deltaShares: Dec;
  currentShares: Dec;
  targetShares: Dec;
  price: Dec;
  /** Absolute weight gap that justified the trade, in NAV percentage points. */
  gapPctPoints: Dec;
  reason: "ENTRY" | "EXIT" | "BAND_EXCEEDED";
};

const HUNDRED = new Dec(100);

/**
 * Trade a line only when the absolute weight gap exceeds the charter's band, or on an entry or exit
 * (ALPHA_CHARTER.md section 8 rebalance rule). The cash leg absorbs the residual, so no order is generated
 * for it here.
 */
export function rebalanceOrders(input: {
  nav: Dec;
  targets: readonly ShareTarget[];
  /** Current whole-share holdings, keyed by entity id. Entities absent from `targets` are exits. */
  current: ReadonlyMap<string, Dec>;
  prices: ReadonlyMap<string, Dec>;
  bandPctPoints: Dec;
}): RebalanceOrder[] {
  if (!input.nav.gt(0)) throw new SizingInputError("nav must be positive");
  if (input.bandPctPoints.isNegative()) throw new SizingInputError("bandPctPoints must be non-negative");
  const orders: RebalanceOrder[] = [];
  const targetIds = new Set(input.targets.map((t) => t.entityId));

  for (const t of input.targets) {
    const cur = input.current.get(t.entityId) ?? ZERO;
    const delta = t.targetShares.minus(cur);
    if (delta.isZero()) continue;
    const currentWeight = cur.times(t.price).div(input.nav);
    const gap = t.achievedWeight.minus(currentWeight).abs().times(HUNDRED);
    const isEntry = !cur.gt(0);
    if (!isEntry && gap.lte(input.bandPctPoints)) continue;
    orders.push({
      entityId: t.entityId,
      deltaShares: delta,
      currentShares: cur,
      targetShares: t.targetShares,
      price: t.price,
      gapPctPoints: gap,
      reason: isEntry ? "ENTRY" : "BAND_EXCEEDED",
    });
  }

  for (const [entityId, cur] of [...input.current].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (targetIds.has(entityId) || !cur.gt(0)) continue;
    const price = input.prices.get(entityId);
    if (price === undefined) continue;
    // An exit always trades: the band never keeps a position the rules removed from the book.
    orders.push({
      entityId,
      deltaShares: cur.negated(),
      currentShares: cur,
      targetShares: ZERO,
      price,
      gapPctPoints: cur.times(price).div(input.nav).times(HUNDRED),
      reason: "EXIT",
    });
  }
  return orders.sort((a, b) => (a.entityId < b.entityId ? -1 : 1));
}
