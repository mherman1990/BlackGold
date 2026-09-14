import { Dec, ZERO, sumDec, type IsoDate, type UtcInstant } from "@blackgold/shared";

/**
 * Deterministic ETF theme look-through (strategies/etf-trend-vol/ALPHA_CHARTER.md section 2.2; D-53 slice 3a).
 *
 * The compliance engine takes an ETF's restricted-theme exposures as an INPUT (`ComplianceInput.themeExposures`);
 * `undefined` there means look-through has not run, which fails closed for new risk (D-46). This module is the
 * code that computes that input from the ETF's published holdings, so a diversified ETF can clear compliance
 * instead of failing closed forever.
 *
 * The rule, verbatim from the charter, is a **compliance decision, not a research parameter**: "a diversified
 * ETF is admissible when the aggregate weight of restricted-theme issuers in the latest published holdings is at
 * or below 10% of ETF NAV". So this engine sums the weight of the DISTINCT constituents that belong to any
 * restricted theme and compares that one aggregate against the owner-set threshold:
 *
 *  - aggregate restricted-theme weight <= threshold -> the ETF is admissible; `themeExposures` is empty (a de
 *    minimis restricted holding does not block, exactly as section 2.2 intends).
 *  - aggregate restricted-theme weight >  threshold -> the ETF is NOT admissible; `themeExposures` names every
 *    restricted theme present among its constituents, so the compliance engine blocks new risk and reports it.
 *
 * It is pure and fail-closed. It reads no model, broker, or network. Two states are unknown, and unknown blocks
 * new risk rather than defaulting to admissible: absent holdings (`undefined`) and holdings older than the
 * owner-set freshness limit both return `undefined`, which the resolver forwards as `themeExposures: undefined`
 * -> `UNKNOWN_LOOK_THROUGH`. Which issuers belong to which restricted theme is owner-authored compliance content
 * (a positive membership list — an issuer absent from it is simply not a restricted-theme issuer); this engine
 * never authors it, it consumes it. The threshold and the freshness limit are likewise owner policy, passed in.
 */

/** One constituent line of an ETF's published holdings: the issuer's identity and its weight as a fraction of ETF NAV. */
export type HoldingLine = {
  /** The constituent's ticker as the holdings file lists it. */
  symbol: string;
  /** The constituent's resolved stable entity id, when known; folded into the membership match with `symbol`. */
  entityId?: string | undefined;
  /** Weight as a fraction of the ETF's NAV (e.g. `0.031` for 3.1%). Long ETFs: never negative. */
  weight: Dec;
};

/** An ETF's published holdings as of a publication date. Point-in-time: the caller supplies the vintage it read. */
export type EtfHoldings = {
  etf: string;
  /** The holdings-file as-of (publication) date. Drives the freshness check. */
  asOf: IsoDate;
  lines: readonly HoldingLine[];
};

/**
 * The owner-authored membership content: the restricted themes a single issuer belongs to, matched by the
 * issuer's ticker and/or resolved entity id. A positive list — an issuer the content does not name belongs to no
 * restricted theme. This module consumes it; authoring it (which companies are `crop_inputs`, `soybean_processing`,
 * refiner-RFS-45Z, ...) is the owner's compliance decision.
 */
export type ThemeMembership = (constituent: { symbol: string; entityId?: string | undefined }) => readonly string[];

export type LookThroughParams = {
  /** The restricted themes in force (from the restricted list). Only these are counted or reported. */
  restrictedThemes: readonly string[];
  /**
   * The maximum aggregate weight of restricted-theme issuers, as a fraction of ETF NAV, at or below which the
   * ETF is admissible (charter section 2.2 proposes 0.10). A compliance decision the owner sets, not a default.
   */
  maxAggregateThemeWeightPct: Dec;
  /** Max age in days the holdings file may be before it is treated as unknown (fail closed). */
  maxHoldingsAgeDays: number;
};

export type LookThroughVerdict = {
  /**
   * The restricted themes the ETF is materially exposed to, for `ComplianceInput.themeExposures`. Empty when the
   * aggregate restricted-theme weight is within the threshold (admissible); the present restricted themes,
   * sorted, when it is over (blocked).
   */
  themeExposures: string[];
  /** True iff the aggregate restricted-theme weight is at or below the threshold. */
  admissible: boolean;
  /** Aggregate weight of the distinct restricted-theme constituents, as a fraction of ETF NAV. */
  aggregateThemeWeight: Dec;
  /** Per-theme aggregate constituent weight (a constituent can count toward more than one theme), for the record. */
  perThemeWeight: { theme: string; weight: Dec }[];
};

const DAY_MS = 86_400_000;

/** Whole days between the holdings as-of date and the decision instant, both truncated to their UTC date. */
function ageDays(now: UtcInstant, asOf: IsoDate): number {
  const nowDate = Date.parse(`${now.slice(0, 10)}T00:00:00.000Z`);
  const fileDate = Date.parse(`${asOf}T00:00:00.000Z`);
  return Math.floor((nowDate - fileDate) / DAY_MS);
}

/**
 * Compute an ETF's restricted-theme exposure from its holdings. Returns `undefined` when look-through cannot be
 * trusted — no holdings, or holdings older than `maxHoldingsAgeDays` — so the caller fails closed. Otherwise the
 * verdict's `themeExposures` is empty when the ETF is admissible (aggregate within threshold) and names the
 * present restricted themes when it is not.
 */
export function evaluateLookThrough(
  holdings: EtfHoldings | undefined,
  membership: ThemeMembership,
  params: LookThroughParams,
  now: UtcInstant,
): LookThroughVerdict | undefined {
  // Unknown holdings block new risk rather than defaulting to admissible (section 2.2; the compliance engine's
  // UNKNOWN_LOOK_THROUGH). Absent, or staler than the owner-set freshness limit, is unknown.
  if (holdings === undefined) return undefined;
  if (ageDays(now, holdings.asOf) > params.maxHoldingsAgeDays) return undefined;

  const restricted = new Set(params.restrictedThemes);
  const perTheme = new Map<string, Dec>();
  // The aggregate is over DISTINCT constituents: an issuer in two restricted themes is one issuer's weight in the
  // aggregate, though it counts toward each of its themes in the per-theme breakdown. Dedupe by canonical
  // identity (entity id, or symbol when unresolved), matching how the membership content is keyed.
  const restrictedWeightByConstituent = new Map<string, Dec>();
  const presentThemes = new Set<string>();

  for (const line of holdings.lines) {
    const themes = membership({ symbol: line.symbol, entityId: line.entityId }).filter((t) => restricted.has(t));
    if (themes.length === 0) continue;
    const key = line.entityId ?? line.symbol;
    // A constituent can appear on more than one line (rare, but holdings files split share classes); take the
    // greatest weight seen for it rather than summing duplicates into a phantom over-weight.
    const prior = restrictedWeightByConstituent.get(key);
    if (prior === undefined || line.weight.gt(prior)) restrictedWeightByConstituent.set(key, line.weight);
    for (const t of themes) {
      presentThemes.add(t);
      perTheme.set(t, (perTheme.get(t) ?? ZERO).plus(line.weight));
    }
  }

  const aggregateThemeWeight = sumDec([...restrictedWeightByConstituent.values()]);
  const admissible = aggregateThemeWeight.lte(params.maxAggregateThemeWeightPct);
  const perThemeWeight = [...perTheme]
    .map(([theme, weight]) => ({ theme, weight }))
    .sort((a, b) => (a.theme < b.theme ? -1 : a.theme > b.theme ? 1 : 0));

  return {
    themeExposures: admissible ? [] : [...presentThemes].sort(),
    admissible,
    aggregateThemeWeight,
    perThemeWeight,
  };
}

/**
 * Adapt the look-through engine into the `(etf) => themeExposures | undefined` resolver the prospective decision
 * loop consumes (`shadow-decision.ts`'s `lookThrough`). `holdingsOf` supplies each ETF's point-in-time holdings
 * as of the decision instant (a later slice reads them from the store); an ETF with none resolves to `undefined`
 * and so fails closed. Pure: it closes over the injected reads and computes, touching no store or network here.
 */
export function lookThroughResolver(
  holdingsOf: (etf: string) => EtfHoldings | undefined,
  membership: ThemeMembership,
  params: LookThroughParams,
  now: UtcInstant,
): (etf: string) => readonly string[] | undefined {
  return (etf) => {
    const verdict = evaluateLookThrough(holdingsOf(etf), membership, params, now);
    return verdict === undefined ? undefined : verdict.themeExposures;
  };
}
