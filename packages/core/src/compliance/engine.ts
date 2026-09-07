import type { UtcInstant } from "@blackgold/shared";
import type { RestrictedListConfig } from "../config/schema.ts";

/**
 * The deterministic compliance engine (docs/PRODUCT_SPEC.md section 8; PLAN.md Phase 4).
 *
 * A pure re-check of a candidate against the restricted list, separate from research and sizing (the spec
 * keeps compliance a distinct verdict object). It admits or rejects with reason codes; it never re-sizes and
 * reads no model, broker, or network.
 *
 * Two rules from the restricted-list design (D-14) are load-bearing and encoded here:
 *
 * - **Additions are immediate.** A name, ETF, or theme on the list restricts on the same decision - membership
 *   is all it takes.
 * - **Removals wait a cooling period.** An item does not leave the list when the owner requests its removal; it
 *   stays restricted until its `eligibleAt`, so a quick add-then-remove cannot free a name to trade. An item in
 *   `pendingRemovals` with `now` before `eligibleAt` is still restricted.
 *
 * Fail closed: a restricted list older than the allowed age is treated as unknown state and blocks new risk
 * (the same principle as `risk.yaml` staleness), rather than being trusted as current.
 *
 * Themes are checked against the candidate's supplied theme exposures; computing those exposures (ETF
 * look-through) is a separate Phase 4 piece, so this engine takes them as input rather than deriving them.
 */

export type ComplianceViolation = { code: string; detail: string };
export type ComplianceVerdict = { admitted: boolean; violations: ComplianceViolation[] };

export type ComplianceInput = {
  /** Candidate identifier (ticker for an ETF, or the restricted-name identifier for an equity). */
  symbol: string;
  /** Restricted themes the candidate is exposed to (from ETF look-through). Empty when none are known. */
  themeExposures?: readonly string[];
  restrictedList: RestrictedListConfig;
  /** Decision instant; drives cooling-period and blackout checks. */
  now: UtcInstant;
  /** True for a risk-increasing action (entry or increase). Blackout windows block only new risk. */
  isNewRisk: boolean;
  /** Max age in days the restricted list may be before it fails closed. From `risk.yaml` staleness; omit to skip the age check. */
  maxListAgeDays?: number;
};

const DAY_MS = 86_400_000;

function ageDays(now: UtcInstant, asOf: string): number {
  const nowDate = Date.parse(`${now.slice(0, 10)}T00:00:00.000Z`);
  const listDate = Date.parse(`${asOf}T00:00:00.000Z`);
  return Math.floor((nowDate - listDate) / DAY_MS);
}

export function evaluateCompliance(input: ComplianceInput): ComplianceVerdict {
  const v: ComplianceViolation[] = [];
  const rl = input.restrictedList;
  const nowMs = Date.parse(input.now);
  const nowDate = input.now.slice(0, 10);

  // Fail closed on a stale list: an unknown restriction picture blocks new risk rather than trusting old data.
  if (input.maxListAgeDays !== undefined) {
    const age = ageDays(input.now, rl.asOf);
    if (age > input.maxListAgeDays) {
      v.push({ code: "RESTRICTED_LIST_STALE", detail: `restricted list asOf ${rl.asOf} is ${age}d old, beyond the ${input.maxListAgeDays}d limit; failing closed` });
    }
  }

  // Direct membership: additions are immediate, so a name or ETF on the list restricts now.
  if (rl.names.includes(input.symbol)) v.push({ code: "RESTRICTED_NAME", detail: `${input.symbol} is on the restricted names list` });
  if (rl.etfs.includes(input.symbol)) v.push({ code: "RESTRICTED_ETF", detail: `${input.symbol} is on the restricted ETFs list` });

  // Cooling period: an item requested for removal is still restricted until its eligibleAt.
  for (const pr of rl.pendingRemovals) {
    if (pr.item === input.symbol && nowMs < Date.parse(pr.eligibleAt)) {
      v.push({ code: "RESTRICTED_COOLING", detail: `${input.symbol} removal is in its cooling period until ${pr.eligibleAt}` });
    }
  }

  // Theme restriction (from look-through exposures).
  const restrictedThemes = new Set(rl.themes);
  for (const theme of input.themeExposures ?? []) {
    if (restrictedThemes.has(theme)) v.push({ code: "RESTRICTED_THEME", detail: `${input.symbol} is exposed to the restricted theme '${theme}'` });
  }

  // Event blackout: a window blocks new risk only.
  if (input.isNewRisk) {
    for (const b of rl.blackouts) {
      if (b.from <= nowDate && nowDate <= b.to) {
        v.push({ code: "BLACKOUT", detail: `new risk is blocked ${b.from}..${b.to}: ${b.reason}` });
      }
    }
  }

  return { admitted: v.length === 0, violations: v };
}
