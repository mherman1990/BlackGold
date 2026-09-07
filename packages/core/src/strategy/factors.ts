import { admittedRiskEtfs, type Charter } from "./charter.ts";

/**
 * Deterministic factor classification (docs/PRODUCT_SPEC.md sections 6 and 11).
 *
 * The Analyst emits a `factorsTouched` set; this module is the independent, code-side authority it is checked
 * against, so no model claim can become the classification (threat model T-05). The assignments live in the
 * charter and are covered by its hash - see `Factors` in `charter.ts`. Nothing here reads a model, a broker, or
 * the network; it is a pure function of the frozen charter.
 */

export type FactorClassification = {
  symbol: string;
  /** The factors this instrument is deterministically classified as touching. Empty when `classified` is false. */
  factors: ReadonlySet<string>;
  /**
   * False when the charter declares no assignment for this symbol. The caller must fail closed on it - an
   * unknown classification blocks new risk (spec section 11) - and must not read the empty set as a confident
   * "this instrument touches no factors".
   */
  classified: boolean;
};

/** The closed factor vocabulary the charter declares, empty when the charter carries no `factors` block. */
export function factorTaxonomy(charter: Charter): ReadonlySet<string> {
  return new Set(charter.factors?.taxonomy ?? []);
}

/**
 * Classify a candidate's factor exposures from the charter. A symbol the charter does not assign is
 * `classified: false`; the caller fails closed on it rather than treating the empty set as "touches nothing".
 */
export function classifyCandidateFactors(charter: Charter, symbol: string): FactorClassification {
  const tags = charter.factors?.assignments[symbol];
  if (tags === undefined) return { symbol, factors: new Set(), classified: false };
  return { symbol, factors: new Set(tags), classified: true };
}

/**
 * Admitted risk ETFs the charter has not classified. A non-empty result is a fail-closed gap: those candidates
 * cannot be assessed until the charter assigns their factors, and admitting one later is a charter edit with a
 * new hash. The cash ETF is excluded - it is never a research candidate.
 */
export function unclassifiedRiskEtfs(charter: Charter): string[] {
  const assigned = new Set(Object.keys(charter.factors?.assignments ?? {}));
  return admittedRiskEtfs(charter).filter((s) => !assigned.has(s));
}
