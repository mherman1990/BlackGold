import type { UtcInstant } from "@blackgold/shared";
import type { RestrictedListConfig } from "../config/schema.ts";

/**
 * The deterministic compliance engine (docs/PRODUCT_SPEC.md sections 7 and 8; PLAN.md Phase 4).
 *
 * A pure re-check of a candidate against the restricted list, separate from research and sizing. It admits or
 * rejects with reason codes; it reads no model, broker, or network.
 *
 * The governing principle (D-14, spec section 7): **compliance gates NEW sleeve exposure only.** An entry or
 * an increase into a restricted name, ETF, theme, blackout window, or a stale/unknown state is blocked. A
 * reduction or exit is never blocked here - you can always de-risk a holding that has become restricted, you
 * simply cannot add to it. So a call with `isNewRisk: false` is always compliance-clear.
 *
 * Within the new-risk path the rules are fail-closed:
 *
 * - **Additions are immediate; removals wait a cooling period.** An item stays restricted until the LATER of
 *   its stored `eligibleAt` and `requestedAt + coolingPeriodDays`, so a too-early `eligibleAt` cannot shorten
 *   the configured cooling.
 * - **Unknown ETF look-through blocks.** `themeExposures` of `undefined` means look-through has not run - an
 *   unknown state that blocks new risk (spec section 7). A known-empty exposure set is `[]`.
 * - **A stale restricted list blocks.** Older than the allowed age is treated as unknown, not trusted.
 * - **Identity is by entity, not by string.** Matching runs against the entity's complete resolved identity:
 *   its stable `entityId` AND every ticker it has carried, so a restricted company cannot be admitted under a
 *   new ticker (docs/DATA_PROVENANCE_SPEC.md section 6a). `identifiers` (the tickers) is REQUIRED - the engine
 *   cannot query the entity map itself, so an optional list would let a caller silently reintroduce the bypass.
 *   `EntityMap.symbolsFor(entityId)` returns only tickers, NOT the entity id, so the stable `entityId` is
 *   passed separately and folded into the match set; a restricted list may key on either. A caller with no
 *   ticker history and no resolved entity id passes the current symbol alone, asserting identity is resolved.
 */

export type ComplianceViolation = { code: string; detail: string };
export type ComplianceVerdict = { admitted: boolean; violations: ComplianceViolation[] };

export type ComplianceInput = {
  /** Candidate identifier for human-readable detail (ticker for an ETF, or the restricted-name id for an equity). */
  symbol: string;
  /**
   * The entity's current and historical tickers, from `EntityMap.symbolsFor(entityId)`. Required, and matching
   * runs against it (plus `symbol` and `entityId`): the engine cannot resolve identity itself, so an optional
   * set would let a caller reintroduce the ticker-change bypass. Pass the current symbol alone only when there
   * is no ticker history.
   */
  identifiers: readonly string[];
  /**
   * The stable entity id (docs/DATA_PROVENANCE_SPEC.md section 6a) folded into the match set, because
   * `symbolsFor` returns only tickers so a restricted list keyed on the entity id would otherwise be missed.
   * REQUIRED but nullable: a caller must pass the resolved id, or an explicit `undefined` for an ad-hoc symbol
   * with no resolved entity - it cannot be silently omitted, which would recreate the ticker-change bypass.
   */
  entityId: string | undefined;
  /** Restricted themes the candidate is exposed to. `undefined` means ETF look-through has NOT run (unknown state, blocks new risk); `[]` means known-empty. */
  themeExposures?: readonly string[] | undefined;
  restrictedList: RestrictedListConfig;
  /** Decision instant; drives cooling-period, blackout, and staleness checks. */
  now: UtcInstant;
  /** True for a risk-increasing action (entry or increase). Restrictions gate new exposure only; a reduction or exit is always compliance-clear. */
  isNewRisk: boolean;
  /** Max age in days the restricted list may be before it fails closed. Required - `risk.yaml` always supplies `staleness.restrictedListMaxAgeDays`. */
  maxListAgeDays: number;
};

const DAY_MS = 86_400_000;

function ageDays(now: UtcInstant, asOf: string): number {
  const nowDate = Date.parse(`${now.slice(0, 10)}T00:00:00.000Z`);
  const listDate = Date.parse(`${asOf}T00:00:00.000Z`);
  return Math.floor((nowDate - listDate) / DAY_MS);
}

export function evaluateCompliance(input: ComplianceInput): ComplianceVerdict {
  // Compliance gates NEW sleeve exposure only. A reduction or exit is always compliance-clear - de-risking a
  // restricted holding must never be trapped.
  if (!input.isNewRisk) return { admitted: true, violations: [] };

  const v: ComplianceViolation[] = [];
  const rl = input.restrictedList;
  const nowMs = Date.parse(input.now);
  const nowDate = input.now.slice(0, 10);
  const ids = new Set<string>([input.symbol, ...input.identifiers, ...(input.entityId !== undefined ? [input.entityId] : [])]);

  // Fail closed on a stale list: an unknown restriction picture blocks new risk rather than trusting old data.
  const age = ageDays(input.now, rl.asOf);
  if (age > input.maxListAgeDays) {
    v.push({ code: "RESTRICTED_LIST_STALE", detail: `restricted list asOf ${rl.asOf} is ${age}d old, beyond the ${input.maxListAgeDays}d limit; failing closed` });
  }

  // Direct membership by entity identity: additions are immediate, and any known ticker of the entity matches.
  if (rl.names.some((n) => ids.has(n))) v.push({ code: "RESTRICTED_NAME", detail: `${input.symbol} (or an alias) is on the restricted names list` });
  if (rl.etfs.some((e) => ids.has(e))) v.push({ code: "RESTRICTED_ETF", detail: `${input.symbol} (or an alias) is on the restricted ETFs list` });

  // Cooling period: restricted until the LATER of the stored eligibleAt and requestedAt + coolingPeriodDays,
  // so a too-early eligibleAt cannot bypass the configured interval.
  for (const pr of rl.pendingRemovals) {
    if (!ids.has(pr.item)) continue;
    const effectiveEligibleMs = Math.max(Date.parse(pr.eligibleAt), Date.parse(pr.requestedAt) + rl.coolingPeriodDays * DAY_MS);
    if (nowMs < effectiveEligibleMs) {
      v.push({ code: "RESTRICTED_COOLING", detail: `${input.symbol} removal is in its cooling period until ${new Date(effectiveEligibleMs).toISOString()}` });
    }
  }

  // Theme restriction (from look-through). An unknown look-through blocks new risk.
  if (input.themeExposures === undefined) {
    v.push({ code: "UNKNOWN_LOOK_THROUGH", detail: `${input.symbol} ETF look-through has not run; unknown theme exposure blocks new risk` });
  } else {
    const restrictedThemes = new Set(rl.themes);
    for (const theme of input.themeExposures) {
      if (restrictedThemes.has(theme)) v.push({ code: "RESTRICTED_THEME", detail: `${input.symbol} is exposed to the restricted theme '${theme}'` });
    }
  }

  // Event blackout window.
  for (const b of rl.blackouts) {
    if (b.from <= nowDate && nowDate <= b.to) v.push({ code: "BLACKOUT", detail: `new risk is blocked ${b.from}..${b.to}: ${b.reason}` });
  }

  return { admitted: v.length === 0, violations: v };
}
