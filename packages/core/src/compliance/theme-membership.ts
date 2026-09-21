import { Dec, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { RestrictedListConfig, ThemeMembershipConfig } from "../config/schema.ts";
import type { ReadOnlyPointInTime } from "../data/pit/types.ts";
import type { EntityMap } from "../market/entity-map.ts";
import { ssgaHoldingsSourceId, type SsgaHoldingsValue } from "../data/adapters/ssga-holdings.ts";
import { lookThroughResolver, type EtfHoldings, type LookThroughParams, type ThemeMembership } from "./look-through.ts";

/**
 * Wiring for the look-through engine (D-53 slice 3a-3): turn the owner-authored theme-membership config and
 * the point-in-time store's published ETF holdings into the `(etf) => themeExposures | undefined` resolver the
 * prospective decision path consumes (`ShadowDecisionContext.lookThrough`).
 *
 * This module authors no compliance content. The issuer -> theme map, the admissibility threshold, and the
 * holdings freshness limit all come from `theme-membership.yaml` (the owner's; the tracked example is fake),
 * and the restricted themes in force come from the restricted list. It reads only the narrowed point-in-time
 * surface - the same `asOf` availability filter every decision read goes through - so a holdings file fetched
 * after the decision instant cannot enter the verdict. Every unknown stays unknown: an ETF with no stored
 * holdings, or none admissible at the decision instant, resolves to `undefined`, which the compliance engine
 * turns into `UNKNOWN_LOOK_THROUGH` and blocks for new risk.
 */

/** Build the `ThemeMembership` matcher from the owner-authored config. Matching is case-sensitive and exact. */
export function themeMembershipOf(cfg: ThemeMembershipConfig): ThemeMembership {
  const bySymbol = new Map<string, Set<string>>();
  const byEntity = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, themes: readonly string[]): void => {
    const set = map.get(key) ?? new Set<string>();
    for (const t of themes) set.add(t);
    map.set(key, set);
  };
  for (const issuer of cfg.issuers) {
    for (const s of issuer.symbols) add(bySymbol, s, issuer.themes);
    if (issuer.entityId !== undefined) add(byEntity, issuer.entityId, issuer.themes);
  }
  return (constituent) => {
    // Union of symbol and entity-id matches: a constituent matching several entries carries every theme any
    // of them names, so an incomplete alias list can only under-identify one entry, never erase another's.
    const themes = new Set<string>(bySymbol.get(constituent.symbol) ?? []);
    if (constituent.entityId !== undefined) for (const t of byEntity.get(constituent.entityId) ?? []) themes.add(t);
    return [...themes].sort();
  };
}

/**
 * The look-through parameters: restricted themes from the restricted list (only themes on it are counted or
 * reported), threshold and freshness from the owner's theme-membership config.
 */
export function lookThroughParamsOf(cfg: ThemeMembershipConfig, restrictedList: RestrictedListConfig): LookThroughParams {
  return {
    restrictedThemes: restrictedList.themes,
    maxAggregateThemeWeightPct: new Dec(cfg.maxAggregateThemeWeightPct),
    maxHoldingsAgeDays: cfg.maxHoldingsAgeDays,
  };
}

export type StoredHoldingsReadOptions = {
  /** The decision instant; `asOf` admits only holdings available (fetch instant + processing delay) by then. */
  decisionAt: UtcInstant;
  snapshotId?: string;
  processingDelayMs?: number;
  /**
   * Resolve a constituent's stable entity id from its ticker as of the holdings as-of date (Codex P1, PR
   * #100): a holdings workbook can list an issuer under an alias or a changed symbol the owner's membership
   * entry does not enumerate, and without the resolved identity the membership's `entityId` match is
   * unreachable through this path - the aliased issuer would read as unrestricted. Pass
   * {@link entityMapResolver} for the point-in-time entity map. Absent, lines match by ticker alone, which is
   * only sound while the membership content enumerates every share class and alias itself.
   */
  resolveEntityId?: (symbol: string, asOf: IsoDate) => string | undefined;
};

/**
 * Adapt the point-in-time {@link EntityMap} into {@link StoredHoldingsReadOptions.resolveEntityId}: each
 * constituent resolves under the symbol's owner as of the holdings as-of date, using only ranges known by the
 * decision instant (a symbol reassignment recorded later cannot reach back into this decision).
 */
export function entityMapResolver(map: EntityMap, decisionAt: UtcInstant): (symbol: string, asOf: IsoDate) => string | undefined {
  return (symbol, asOf) => map.resolve(symbol, asOf, { knownAt: decisionAt });
}

/**
 * Read an ETF's newest admissible published holdings from the point-in-time store (`etf_holdings.ssga.<ETF>`,
 * one observation per fetched workbook; a corrected re-publication supersedes via its later vintage). Among
 * the admissible rows the one with the newest holdings as-of date wins - the freshness judgment itself
 * (is that date recent enough?) stays in `evaluateLookThrough`, so this reader never turns "stale" into
 * "absent" and the fail-closed reason stays honest. No stored holdings means `undefined`: unknown, not empty.
 */
export function storedHoldingsOf(pit: ReadOnlyPointInTime, opts: StoredHoldingsReadOptions): (etf: string) => EtfHoldings | undefined {
  return (etf) => {
    const res = pit.asOf<SsgaHoldingsValue>({
      sourceId: ssgaHoldingsSourceId(etf),
      entityId: etf,
      decisionAt: opts.decisionAt,
      ...(opts.snapshotId === undefined ? {} : { snapshotId: opts.snapshotId }),
      ...(opts.processingDelayMs === undefined ? {} : { processingDelayMs: opts.processingDelayMs }),
    });
    // One collapsed row per holdings as-of date (vintage supersession is asOf's); keep the newest as-of.
    let best: { asOf: IsoDate; id: number; value: SsgaHoldingsValue } | undefined;
    for (const row of res.rows) {
      const v = row.value;
      if (best === undefined || v.asOf > best.asOf || (v.asOf === best.asOf && row.id > best.id)) {
        best = { asOf: v.asOf, id: row.id, value: v };
      }
    }
    if (best === undefined) return undefined;
    const asOf = best.value.asOf;
    return {
      etf: best.value.etf,
      asOf,
      lines: best.value.lines.map((l) => {
        const entityId = opts.resolveEntityId?.(l.symbol, asOf);
        return { symbol: l.symbol, ...(entityId === undefined ? {} : { entityId }), weight: new Dec(l.weight) };
      }),
    };
  };
}

/**
 * The complete wiring: point-in-time holdings + owner membership + restricted list -> the resolver
 * `ShadowDecisionContext.lookThrough` takes. Pure over its inputs; the caller (the serve job, slice 2c)
 * resolves the store, configs, charter, and decision instant.
 *
 * `lookThroughScope` is the signed charter's `universe.look_through_flagged` - the ETFs the owner declared as
 * carrying potential restricted-theme exposure and therefore requiring holdings look-through (Codex P1, PR
 * #100: the store's only holdings source is SSGA, so evaluating every risk ETF against it would leave every
 * non-SPDR member permanently `UNKNOWN_LOOK_THROUGH` and block the whole book). An ETF outside the scope
 * resolves to `[]`: not a skipped check but the charter's own hash-covered declaration that no look-through is
 * required for it - consuming owner policy, not authoring it. Inside the scope, unknowns stay unknown and
 * block new risk as before.
 */
export function storedLookThroughResolver(
  pit: ReadOnlyPointInTime,
  membership: ThemeMembershipConfig,
  restrictedList: RestrictedListConfig,
  opts: StoredHoldingsReadOptions & {
    /** `charter.universe.look_through_flagged`: the ETFs look-through applies to. */
    lookThroughScope: readonly string[];
  },
): (etf: string) => readonly string[] | undefined {
  const scope = new Set(opts.lookThroughScope);
  // A vacuous membership against a live restricted-theme list is missing owner content, not a clean policy
  // (Codex P1, round 2): with no issuer mapped to any restricted theme, every holding would read as
  // unrestricted and an in-scope ETF would clear on silence. The schema already rejects an OMITTED `issuers`;
  // an explicitly empty (or restricted-theme-disjoint) one fails closed here - in-scope ETFs resolve to
  // `undefined` -> UNKNOWN_LOOK_THROUGH - until the owner's content actually covers the themes in force.
  const restrictedThemes = new Set(restrictedList.themes);
  const membershipCoversRestricted =
    restrictedThemes.size === 0 || membership.issuers.some((i) => i.themes.some((t) => restrictedThemes.has(t)));
  const inScope = lookThroughResolver(
    storedHoldingsOf(pit, opts),
    themeMembershipOf(membership),
    lookThroughParamsOf(membership, restrictedList),
    opts.decisionAt,
  );
  return (etf) => (scope.has(etf) ? (membershipCoversRestricted ? inScope(etf) : undefined) : []);
}
