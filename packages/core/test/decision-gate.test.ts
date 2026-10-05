import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Dec, ONE, sumDec, utc } from "@blackgold/shared";
import { RiskConfigSchema, RestrictedListConfigSchema, type RiskConfig, type RestrictedListConfig } from "../src/config/schema.ts";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import type { HaltInput, PortfolioSnapshot } from "../src/risk/halt.ts";
import type { RiskLimitsInput } from "../src/risk/limits.ts";
import type { ComplianceInput } from "../src/compliance/engine.ts";
import type { LiquidityFacts } from "../src/risk/liquidity.ts";
import { evaluateDecisionGate } from "../src/decision/gate.ts";

const POLICY: RiskConfig = RiskConfigSchema.parse({});
const CHARTER: Charter = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
const RL: RestrictedListConfig = RestrictedListConfigSchema.parse({ asOf: "2026-09-01", etfs: ["FAKEAG"] });
const NOW = utc("2026-09-10T14:00:00Z");

function snapshot(nav: number, hwm = 100, start = 100): PortfolioSnapshot {
  return { nav: new Dec(nav), highWaterMark: new Dec(hwm), sessionStartNav: new Dec(start) };
}
function halt(portfolio: PortfolioSnapshot): HaltInput {
  return { policy: POLICY, current: "NORMAL", portfolio };
}
function book(w: Record<string, string>): RiskLimitsInput {
  const weights = new Map(Object.entries(w).map(([k, s]) => [k, new Dec(s)] as const));
  return { policy: POLICY, charter: CHARTER, weights, cashWeight: ONE.minus(sumDec(weights.values())) };
}
/** The book in force before this decision, so the target/current delta names the new-risk set. */
function cur(w: Record<string, string>): ReadonlyMap<string, Dec> {
  return new Map(Object.entries(w).map(([k, s]) => [k, new Dec(s)] as const));
}
function candidate(symbol: string, over: Partial<Omit<ComplianceInput, "isNewRisk" | "symbol">> = {}): Omit<ComplianceInput, "isNewRisk"> {
  return { symbol, identifiers: [symbol], entityId: undefined, themeExposures: [], restrictedList: RL, now: NOW, maxListAgeDays: 120, ...over };
}

const CLEAN_BOOK = { XLF: "0.19", XLV: "0.19", XLU: "0.19", XLP: "0.19", XLI: "0.19" };
/** Liquidity facts (ADV and price in USD) that clear every floor, for each holding the tests use. */
function liq(over: Record<string, Partial<LiquidityFacts>> = {}): ReadonlyMap<string, LiquidityFacts> {
  const m = new Map<string, LiquidityFacts>();
  for (const id of ["XLF", "XLV", "XLU", "XLP", "XLI", "XLK"]) m.set(id, { advUsd: new Dec("900000000"), price: new Dec("50"), ...over[id] });
  return m;
}
const LIQ = liq();

describe("evaluateDecisionGate", () => {
  it("allows new risk only when halt, limits, and compliance all clear", () => {
    // XLU/XLP/XLI are held flat (in the current book); only XLF and XLV take new risk, and both clear.
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book(CLEAN_BOOK),
      currentWeights: cur({ XLU: "0.19", XLP: "0.19", XLI: "0.19" }),
      newRiskCandidates: [candidate("XLF"), candidate("XLV")],
      liquidity: LIQ,
    });
    expect(v.newRiskAllowed).toBe(true);
    expect(v.blockedBy).toEqual([]);
    expect(v.haltState).toBe("NORMAL");
    expect(v.increasedRisk).toEqual(["XLF", "XLV"]);
  });

  it("blocks when the halt state forbids new risk, whatever the book and candidates", () => {
    // 10% drawdown -> HOLD_ONLY. Only XLF is new; it is covered, so the sole block is the halt state.
    const v = evaluateDecisionGate({
      halt: halt(snapshot(90)),
      limits: book(CLEAN_BOOK),
      currentWeights: cur({ XLV: "0.19", XLU: "0.19", XLP: "0.19", XLI: "0.19" }),
      newRiskCandidates: [candidate("XLF")],
      liquidity: LIQ,
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.haltState).toBe("HOLD_ONLY");
    // Per-fault detail is preserved, not just the code.
    expect(v.blockedBy.some((b) => b.startsWith("halt DRAWDOWN_HOLD_ONLY:"))).toBe(true);
  });

  it("blocks when the proposed book breaches a risk limit", () => {
    // XLF is held flat at 0.25 - still an absolute single-ETF breach; XLV is the only new risk and clears.
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book({ XLF: "0.25", XLV: "0.10" }),
      currentWeights: cur({ XLF: "0.25" }),
      newRiskCandidates: [candidate("XLV")],
      liquidity: LIQ,
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.limits.admitted).toBe(false);
    expect(v.blockedBy.some((b) => b.startsWith("limit SINGLE_ETF_WEIGHT"))).toBe(true);
  });

  it("blocks when a new-risk candidate fails compliance", () => {
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book({ XLF: "0.19" }),
      currentWeights: new Map(),
      newRiskCandidates: [candidate("XLF"), candidate("FAKEAG")],
      liquidity: LIQ,
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.blockedBy.some((b) => b.startsWith("compliance FAKEAG RESTRICTED_ETF"))).toBe(true);
  });

  it("fails closed when the target book increases a holding with no compliance evaluation supplied", () => {
    // The caller lists only XLF, but the empty current book makes every CLEAN_BOOK holding new risk. The
    // gate must not trust the caller's list: the uncovered increases block, restricted-list unchecked.
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book(CLEAN_BOOK),
      currentWeights: new Map(),
      newRiskCandidates: [candidate("XLF")],
      liquidity: LIQ,
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.blockedBy.some((b) => b.startsWith("compliance XLV MISSING_COMPLIANCE"))).toBe(true);
    expect(v.blockedBy.some((b) => b.startsWith("compliance XLU MISSING_COMPLIANCE"))).toBe(true);
    // XLF was supplied, so it is not among the uncovered.
    expect(v.blockedBy.some((b) => b.startsWith("compliance XLF MISSING_COMPLIANCE"))).toBe(false);
  });

  it("binds coverage to the canonical holding, not to a candidate's alias identifiers", () => {
    // One clean XLF candidate that also lists XLV among its identifiers must NOT cover an increased XLV: XLV's
    // own look-through / themeExposures were never evaluated, so it fails closed rather than riding on XLF's.
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book({ XLF: "0.19", XLV: "0.19" }),
      currentWeights: new Map(), // both new risk
      newRiskCandidates: [candidate("XLF", { identifiers: ["XLF", "XLV"] })],
      liquidity: LIQ,
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.blockedBy.some((b) => b.startsWith("compliance XLV MISSING_COMPLIANCE"))).toBe(true);
    expect(v.blockedBy.some((b) => b.startsWith("compliance XLF MISSING_COMPLIANCE"))).toBe(false);
  });

  it("does not require or run new-risk compliance for a restricted holding that is only held, not increased", () => {
    // XLK is on the restricted list but held flat (current == target), so it is not new risk. Only XLF is new.
    const rl = RestrictedListConfigSchema.parse({ asOf: "2026-09-01", etfs: ["XLK"] });
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book({ XLK: "0.19", XLF: "0.19" }),
      currentWeights: cur({ XLK: "0.19" }),
      newRiskCandidates: [candidate("XLF", { restrictedList: rl })],
      liquidity: LIQ,
    });
    expect(v.newRiskAllowed).toBe(true);
    expect(v.blockedBy).toEqual([]);
    expect(v.increasedRisk).toEqual(["XLF"]);
  });

  it("aggregates every blocking reason across the four engines", () => {
    const v = evaluateDecisionGate({
      halt: halt(snapshot(90)), // HOLD_ONLY
      limits: book({ XLF: "0.25", XLV: "0.10" }), // limit breach
      currentWeights: new Map(), // XLF and XLV both new
      newRiskCandidates: [candidate("XLF"), candidate("XLV"), candidate("FAKEAG")], // compliance breach on FAKEAG
      liquidity: liq({ XLV: { price: new Dec("4.99") } }), // liquidity breach on XLV
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.blockedBy.some((b) => b.startsWith("halt "))).toBe(true);
    expect(v.blockedBy.some((b) => b.startsWith("limit "))).toBe(true);
    expect(v.blockedBy.some((b) => b.startsWith("liquidity MIN_PRICE: XLV"))).toBe(true);
    expect(v.blockedBy.some((b) => b.startsWith("compliance "))).toBe(true);
  });

  it("blocks new risk in a holding below a liquidity floor, and names it (D-55)", () => {
    // Everything else clears; XLV is new risk with ADV under minAdvUsd (5M).
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book({ XLF: "0.19", XLV: "0.19" }),
      currentWeights: new Map(),
      newRiskCandidates: [candidate("XLF"), candidate("XLV")],
      liquidity: liq({ XLV: { advUsd: new Dec("4999999") } }),
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.liquidity.admitted).toBe(false);
    expect(v.blockedBy).toEqual([expect.stringMatching(/^liquidity MIN_ADV: XLV ADV 4999999 USD is below minAdvUsd 5000000$/)]);
  });

  it("fails closed when an increasing holding has no liquidity facts: coverage is enforced, not trusted (D-55)", () => {
    const facts = new Map(liq());
    facts.delete("XLV");
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book({ XLF: "0.19", XLV: "0.19" }),
      currentWeights: new Map(),
      newRiskCandidates: [candidate("XLF"), candidate("XLV")],
      liquidity: facts,
    });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.blockedBy.some((b) => b.startsWith("liquidity LIQUIDITY_UNKNOWN: XLV"))).toBe(true);
  });

  it("does not let liquidity block a holding that is only held or reduced (D-55)", () => {
    // XLK is illiquid and unpriced but held flat; XLU is illiquid but reduced. Only XLF takes new risk, and it clears.
    const facts = new Map(liq({ XLU: { advUsd: new Dec("1") } }));
    facts.delete("XLK");
    const v = evaluateDecisionGate({
      halt: halt(snapshot(100)),
      limits: book({ XLK: "0.19", XLU: "0.10", XLF: "0.19" }),
      currentWeights: cur({ XLK: "0.19", XLU: "0.19" }),
      newRiskCandidates: [candidate("XLF")],
      liquidity: facts,
    });
    expect(v.newRiskAllowed).toBe(true);
    expect(v.liquidity.violations).toEqual([]);
  });

  it("evaluates compliance as new risk even though the caller omits isNewRisk", () => {
    // FAKEAG would be compliance-clear as a reduction; the gate must treat it as new risk and block it.
    const v = evaluateDecisionGate({ halt: halt(snapshot(100)), limits: book({}), currentWeights: new Map(), newRiskCandidates: [candidate("FAKEAG")], liquidity: LIQ });
    expect(v.newRiskAllowed).toBe(false);
    expect(v.blockedBy.some((b) => b.includes("RESTRICTED_ETF"))).toBe(true);
  });
});
