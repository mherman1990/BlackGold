import { Dec, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { RestrictedListConfig, ThemeMembershipConfig } from "../config/schema.ts";
import type { ReadOnlyPointInTime } from "../data/pit/types.ts";
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
};

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
    return {
      etf: best.value.etf,
      asOf: best.value.asOf,
      lines: best.value.lines.map((l) => ({ symbol: l.symbol, weight: new Dec(l.weight) })),
    };
  };
}

/**
 * The complete wiring: point-in-time holdings + owner membership + restricted list -> the resolver
 * `ShadowDecisionContext.lookThrough` takes. Pure over its inputs; the caller (the serve job, slice 2c)
 * resolves the store, configs, and decision instant.
 */
export function storedLookThroughResolver(
  pit: ReadOnlyPointInTime,
  membership: ThemeMembershipConfig,
  restrictedList: RestrictedListConfig,
  opts: StoredHoldingsReadOptions,
): (etf: string) => readonly string[] | undefined {
  return lookThroughResolver(
    storedHoldingsOf(pit, opts),
    themeMembershipOf(membership),
    lookThroughParamsOf(membership, restrictedList),
    opts.decisionAt,
  );
}
