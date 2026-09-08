import { Dec, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { Charter } from "./charter.ts";
import type { FeatureSet } from "./features.ts";

/**
 * Candidate engine for a deterministic charter (ALPHA_CHARTER.md section 8).
 *
 * The rule table, not the code, is the specification: eligibility, ranking, entry, hysteresis hold, and exit
 * come from the charter's frozen numbers. The engine is a pure function of `(FeatureSet, held set, params)`,
 * so two independent implementations of the prose charter must agree on the same inputs, which is the
 * acceptance test the charter asks for.
 *
 * Every accepted and rejected candidate is returned with the single rule that decided it
 * (docs/EXPERIMENT_PROTOCOL.md section 6: "Each arm logs accepted and rejected candidates with the rule
 * that accepted or rejected them"). Nothing is silently dropped.
 */

export const STRATEGY_RULES_VERSION = 1;

export const INELIGIBLE_REASONS = [
  /** No usable feature at the anchor (no bar, stale anchor, or a short window). */
  "NO_FEATURES",
  /** `trend_i = 0`: the adjusted close is at or below its own moving average. */
  "TREND_DOWN",
  /** `mom_i <= mom_cash`: the cash leg beat it over the same window. */
  "MOMENTUM_BELOW_CASH",
  /** Average daily dollar volume below the charter's floor. */
  "BELOW_ADV_FLOOR",
  /** Restricted by the compliance layer at this decision. */
  "COMPLIANCE_RESTRICTED",
  /** The cash-leg momentum hurdle itself is unavailable, so no risk ETF can clear it. */
  "CASH_HURDLE_UNAVAILABLE",
] as const;
export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

export const REJECTION_REASONS = [
  ...INELIGIBLE_REASONS,
  /** Eligible, ranked outside the entry rank, and not currently held. */
  "RANK_BELOW_ENTRY",
  /** Held and eligible but ranked outside the hold rank. */
  "RANK_BELOW_HOLD",
  /** Eligible and ranked but skipped because its correlated cluster is already full. */
  "CLUSTER_FULL",
  /** Eligible and ranked but the per-decision new-position cap was already spent. */
  "NEW_POSITION_CAP",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const ACCEPTANCE_REASONS = [
  /** Not held, eligible, ranked inside the entry rank. */
  "ELIGIBLE_WITHIN_ENTRY_RANK",
  /** Held, eligible, ranked inside the wider hold rank: the hysteresis rule. */
  "ELIGIBLE_WITHIN_HOLD_RANK",
  /**
   * Not held and ranked outside the entry rank, admitted because a correlated-cluster cap skipped a
   * higher-ranked name and left a slot (ALPHA_CHARTER.md section 9 step 4: "the next eligible non-cluster
   * ETFs (up to rank 7) fill the slots").
   */
  "ELIGIBLE_BACKFILL_AFTER_CLUSTER_SKIP",
] as const;
export type AcceptanceReason = (typeof ACCEPTANCE_REASONS)[number];

export const HOLD_ACTIONS = ["ENTER", "HOLD", "EXIT", "STAY_OUT"] as const;
export type HoldAction = (typeof HOLD_ACTIONS)[number];

export type CandidateParams = {
  entryRank: number;
  holdRank: number;
  maxPositions: number;
  maxNewPositionsPerDecision: number;
  minAdvUsd: Dec;
  /** Correlated clusters and how many members of each may be held at once. */
  clusters: readonly { id: string; members: readonly string[]; maxMembers: number }[];
};

export function candidateParamsFromCharter(c: Charter): CandidateParams {
  return {
    entryRank: c.rules.entry_rank,
    holdRank: c.rules.hold_rank,
    maxPositions: c.rules.max_positions,
    maxNewPositionsPerDecision: c.rules.max_new_positions_per_decision,
    minAdvUsd: new Dec(c.features.min_adv_usd),
    clusters: c.sizing.clusters.map((cl) => ({ id: cl.id, members: [...cl.members], maxMembers: cl.max_members })),
  };
}

export type Candidate = {
  entityId: string;
  /** 1-based rank among eligible entities by momentum, descending. Undefined when ineligible. */
  rank: number | undefined;
  mom: Dec | undefined;
  trend: boolean | undefined;
  vol: Dec | undefined;
  adv: Dec | undefined;
  px: Dec | undefined;
  eligible: boolean;
  held: boolean;
  action: HoldAction;
  /** The single rule that decided this candidate. */
  reason: RejectionReason | AcceptanceReason;
  /** Cluster whose cap applied, when the reason is CLUSTER_FULL. */
  clusterId?: string;
};

export type CandidateSet = {
  decisionAt: UtcInstant;
  anchorSession: IsoDate;
  /** Entities to hold after the decision, in rank order. At most `maxPositions`. */
  selected: string[];
  /** Held entities the rules exit. */
  exits: string[];
  /** Newly selected entities not previously held. */
  entries: string[];
  /** Every considered entity with its deciding rule, ordered by rank then entity id. */
  candidates: Candidate[];
  cashMom: Dec | undefined;
  labels: string[];
  strategyRulesVersion: number;
};

export type SelectInput = {
  features: FeatureSet;
  /** Entities currently held, for the hysteresis hold rule. */
  held: ReadonlySet<string>;
  params: CandidateParams;
  /** Entities the compliance layer forbids at this decision. Compliance can only remove, never add. */
  restricted?: ReadonlySet<string>;
};

/**
 * Apply the charter's rule table.
 *
 * Order matters and is the charter's: eligibility first, then a momentum ranking over the eligible set only,
 * then a single pass down the ranking that admits a held name inside the hold rank and a new name inside the
 * entry rank, subject to the cluster cap, the book size, and the per-decision new-position cap. A held name
 * that fails eligibility exits regardless of rank; a held name outside the hold rank exits even if eligible.
 */
export function selectCandidates(input: SelectInput): CandidateSet {
  const { features: fs, held, params } = input;
  const restricted = input.restricted ?? new Set<string>();
  if (params.holdRank < params.entryRank) throw new RangeError("holdRank must be at or above entryRank");
  if (params.maxPositions < 1) throw new RangeError("maxPositions must be positive");

  type Row = { entityId: string; mom: Dec | undefined; trend: boolean | undefined; vol: Dec | undefined; adv: Dec | undefined; px: Dec | undefined; eligible: boolean; reason: RejectionReason | undefined };
  const rows: Row[] = [];

  for (const [entityId, f] of [...fs.features].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const row: Row = { entityId, mom: f.mom, trend: f.trend, vol: f.vol, adv: f.adv, px: f.px, eligible: false, reason: undefined };
    if (restricted.has(entityId)) row.reason = "COMPLIANCE_RESTRICTED";
    else if (f.mom === undefined || f.trend === undefined || f.vol === undefined || f.px === undefined || f.adv === undefined) row.reason = "NO_FEATURES";
    else if (fs.cashMom === undefined) row.reason = "CASH_HURDLE_UNAVAILABLE";
    else if (!f.trend) row.reason = "TREND_DOWN";
    else if (!f.mom.gt(fs.cashMom)) row.reason = "MOMENTUM_BELOW_CASH";
    else if (f.adv.lt(params.minAdvUsd)) row.reason = "BELOW_ADV_FLOOR";
    else row.eligible = true;
    rows.push(row);
  }

  // Rank the eligible set by momentum descending; entity id breaks a tie so the ranking is total and stable.
  const eligible = rows.filter((r) => r.eligible);
  eligible.sort((a, b) => {
    const am = a.mom;
    const bm = b.mom;
    if (am && bm && !am.eq(bm)) return bm.gt(am) ? 1 : -1;
    return a.entityId < b.entityId ? -1 : 1;
  });
  const rankOf = new Map<string, number>();
  eligible.forEach((r, i) => rankOf.set(r.entityId, i + 1));

  const clusterCount = new Map<string, number>();
  const clusterOf = new Map<string, { id: string; maxMembers: number }>();
  for (const cl of params.clusters) {
    clusterCount.set(cl.id, 0);
    for (const m of cl.members) clusterOf.set(m, { id: cl.id, maxMembers: cl.maxMembers });
  }

  const selected: string[] = [];
  const entries: string[] = [];
  const decided = new Map<string, { action: HoldAction; reason: RejectionReason | AcceptanceReason; clusterId?: string }>();

  // ------------------------------------------------------------------------------------------
  // Pass 1: rank band. A held name may rank up to holdRank; a new name up to entryRank.
  // ------------------------------------------------------------------------------------------
  const inBand: Row[] = [];
  for (const row of eligible) {
    const rank = rankOf.get(row.entityId) ?? Number.MAX_SAFE_INTEGER;
    const isHeld = held.has(row.entityId);
    if (rank <= (isHeld ? params.holdRank : params.entryRank)) inBand.push(row);
    else decided.set(row.entityId, { action: isHeld ? "EXIT" : "STAY_OUT", reason: isHeld ? "RANK_BELOW_HOLD" : "RANK_BELOW_ENTRY" });
  }

  // ------------------------------------------------------------------------------------------
  // Pass 2: correlated-cluster cap, applied strictly by rank. ALPHA_CHARTER.md section 9 step 4 is
  // explicit that "the lowest-ranked extra members are skipped", so an incumbent does not keep a cluster
  // slot against a higher-ranked name the way it keeps a book slot in pass 3.
  // ------------------------------------------------------------------------------------------
  const clusterCleared: Row[] = [];
  for (const row of inBand) {
    const cluster = clusterOf.get(row.entityId);
    if (cluster !== undefined) {
      if ((clusterCount.get(cluster.id) ?? 0) >= cluster.maxMembers) {
        decided.set(row.entityId, { action: held.has(row.entityId) ? "EXIT" : "STAY_OUT", reason: "CLUSTER_FULL", clusterId: cluster.id });
        continue;
      }
      clusterCount.set(cluster.id, (clusterCount.get(cluster.id) ?? 0) + 1);
    }
    clusterCleared.push(row);
  }

  // ------------------------------------------------------------------------------------------
  // Pass 3: fill the book, incumbents before newcomers (D-32).
  //
  // The charter's entry rule ("enter any ETF ranked 1..5 that is not held") and hold rule ("keep a held ETF
  // while it remains eligible and ranked 1..7") can together name six ETFs for a five-slot book, and section
  // 9 step 1 says only "at most 5". Filling by rank alone would resolve it in favour of the newcomers - and
  // would make the hysteresis band dead code, because whenever five names are eligible, ranks 1 to 5 exist
  // and fill the book before any rank-6 or rank-7 incumbent is reached. That contradicts the band's stated
  // purpose and the charter's own turnover expectation (section 21: 15 to 40 entries or exits per year), so
  // an eligible incumbent inside the hold band keeps its slot and the lowest-ranked newcomer is the one left
  // out. Recorded as D-32, owner-confirmed 2026-09-08 via the ALPHA_CHARTER.md section 8 "Book-slot priority"
  // row; the charter is now frozen with this reading.
  // ------------------------------------------------------------------------------------------
  const incumbents = clusterCleared.filter((r) => held.has(r.entityId));
  const newcomers = clusterCleared.filter((r) => !held.has(r.entityId));
  for (const row of incumbents) {
    if (selected.length >= params.maxPositions) {
      decided.set(row.entityId, { action: "EXIT", reason: "RANK_BELOW_HOLD" });
      continue;
    }
    selected.push(row.entityId);
    decided.set(row.entityId, { action: "HOLD", reason: "ELIGIBLE_WITHIN_HOLD_RANK" });
  }
  for (const row of newcomers) {
    if (selected.length >= params.maxPositions) {
      decided.set(row.entityId, { action: "STAY_OUT", reason: "RANK_BELOW_ENTRY" });
      continue;
    }
    if (entries.length >= params.maxNewPositionsPerDecision) {
      decided.set(row.entityId, { action: "STAY_OUT", reason: "NEW_POSITION_CAP" });
      continue;
    }
    selected.push(row.entityId);
    entries.push(row.entityId);
    decided.set(row.entityId, { action: "ENTER", reason: "ELIGIBLE_WITHIN_ENTRY_RANK" });
  }

  // ------------------------------------------------------------------------------------------
  // Pass 4: a slot vacated by the cluster cap is filled from the next eligible names up to the hold rank
  // (ALPHA_CHARTER.md section 9 step 4). Only a cluster skip creates such a hole: a restricted or ineligible
  // name never enters the ranking, so the ranks below it simply move up.
  // ------------------------------------------------------------------------------------------
  const clusterSkipped = [...decided.values()].some((d) => d.reason === "CLUSTER_FULL");
  if (clusterSkipped) {
    for (const row of eligible) {
      if (selected.length >= params.maxPositions) break;
      const d = decided.get(row.entityId);
      if (d?.reason !== "RANK_BELOW_ENTRY" || d.action !== "STAY_OUT") continue;
      const rank = rankOf.get(row.entityId) ?? Number.MAX_SAFE_INTEGER;
      if (rank > params.holdRank) continue;
      const cluster = clusterOf.get(row.entityId);
      if (cluster !== undefined && (clusterCount.get(cluster.id) ?? 0) >= cluster.maxMembers) {
        decided.set(row.entityId, { action: "STAY_OUT", reason: "CLUSTER_FULL", clusterId: cluster.id });
        continue;
      }
      if (entries.length >= params.maxNewPositionsPerDecision) {
        decided.set(row.entityId, { action: "STAY_OUT", reason: "NEW_POSITION_CAP" });
        continue;
      }
      selected.push(row.entityId);
      if (cluster !== undefined) clusterCount.set(cluster.id, (clusterCount.get(cluster.id) ?? 0) + 1);
      entries.push(row.entityId);
      decided.set(row.entityId, { action: "ENTER", reason: "ELIGIBLE_BACKFILL_AFTER_CLUSTER_SKIP" });
    }
  }

  // Report the book in rank order regardless of the order slots were filled in.
  selected.sort((a, b) => (rankOf.get(a) ?? 0) - (rankOf.get(b) ?? 0));

  const selectedSet = new Set(selected);
  const candidates: Candidate[] = rows.map((row) => {
    const d = decided.get(row.entityId);
    const isHeld = held.has(row.entityId);
    const action: HoldAction = d?.action ?? (isHeld ? "EXIT" : "STAY_OUT");
    const reason: Candidate["reason"] = d?.reason ?? row.reason ?? "NO_FEATURES";
    const c: Candidate = {
      entityId: row.entityId,
      rank: rankOf.get(row.entityId),
      mom: row.mom,
      trend: row.trend,
      vol: row.vol,
      adv: row.adv,
      px: row.px,
      eligible: row.eligible,
      held: isHeld,
      action,
      reason,
    };
    if (d?.clusterId !== undefined) c.clusterId = d.clusterId;
    return c;
  });
  candidates.sort((a, b) => {
    const ar = a.rank ?? Number.MAX_SAFE_INTEGER;
    const br = b.rank ?? Number.MAX_SAFE_INTEGER;
    return ar !== br ? ar - br : a.entityId < b.entityId ? -1 : 1;
  });

  const exits = [...held].filter((e) => !selectedSet.has(e)).sort();
  return {
    decisionAt: fs.decisionAt,
    anchorSession: fs.anchorSession,
    selected,
    exits,
    entries,
    candidates,
    cashMom: fs.cashMom,
    labels: [...fs.labels],
    strategyRulesVersion: STRATEGY_RULES_VERSION,
  };
}
