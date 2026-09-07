import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { Dec, hashJson, type IsoDate, isoDate } from "@blackgold/shared";
import { decString, isoDateString, ratioString } from "../config/schema.ts";

/**
 * Machine-readable companion to `strategies/<id>/ALPHA_CHARTER.md` (docs/EXPERIMENT_PROTOCOL.md section 2).
 *
 * The prose charter is the specification a human reads; this file is the only form the code executes. Every
 * number the strategy uses comes from here, so a parameter cannot be changed by editing code: it is a charter
 * edit, which changes the hash, which makes it a different experiment.
 *
 * Approval is a gate, not a label. `assertRegistrable` refuses a charter whose approval block is unsigned,
 * whose declared open decisions are unresolved, or whose values are still marked proposed. That is what stops
 * a session from freezing an experiment on numbers the owner never agreed to.
 */

const strategyId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "strategy_id must be lowercase kebab-case");
const semver = z.string().regex(/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/, "must be a semantic version");
const symbol = z.string().regex(/^[A-Z][A-Z.]{0,9}$/, "must be an uppercase ticker");
/** A decimal string strictly greater than zero. */
const positiveDecString = decString.refine((s) => new Dec(s).gt(0), "must be greater than zero");

export const APPROVAL_STATES = ["DRAFT", "APPROVED", "REJECTED", "SUPERSEDED"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

const ApprovalBlock = z.strictObject({
  state: z.enum(APPROVAL_STATES),
  /** Who signed. Required once state is APPROVED; the gate checks it, not the schema. */
  approved_by: z.string().min(1).nullable().default(null),
  approval_date: isoDateString.nullable().default(null),
  /** Commit of the tree the owner approved against. */
  code_commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable()
    .default(null),
  /** Path to the written approval record, e.g. a decision id in docs/DECISIONS.md. */
  approval_ref: z.string().min(1).nullable().default(null),
  decision_refs: z.array(z.string().min(1)).default([]),
  conditions: z.array(z.string().min(1)).default([]),
  /**
   * Questions section 24 of the prose charter says block registration. Every entry must carry a
   * `resolution` before the charter can be registered.
   */
  open_decisions: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        question: z.string().min(1),
        resolution: z.string().min(1).nullable().default(null),
      }),
    )
    .default([]),
});

const Universe = z.strictObject({
  universe_id: z.string().min(1),
  /** Frozen at registration; membership is known on every decision date by construction. */
  frozen: z.literal(true),
  risk_etfs: z.array(symbol).min(2),
  cash_etf: symbol,
  /** Members admitted only if a compliance decision allows them. Unresolved entries are excluded, not assumed in. */
  conditional: z.array(z.strictObject({ symbol, condition: z.string().min(1), admitted: z.boolean().nullable().default(null) })).default([]),
  /** Members that need a periodic look-through check but are not conditional. */
  look_through_flagged: z.array(symbol).default([]),
  survivorship_free: z.boolean(),
  survivorship_note: z.string().min(1),
});

const Features = z.strictObject({
  momentum_lookback_sessions: z.int().min(2),
  momentum_skip_sessions: z.int().min(0),
  trend_sma_sessions: z.int().min(2),
  volatility_sessions: z.int().min(2),
  adv_sessions: z.int().min(1),
  min_adv_usd: positiveDecString,
});

const Rules = z.strictObject({
  cadence: z.literal("WEEKLY_LAST_SESSION"),
  /** Minutes after the session close at which the decision is timestamped. */
  decision_offset_minutes: z.int().min(0),
  /** Sessions between the decision and the assumed executable bar. */
  execution_delay_bars: z.int().min(0),
  fill_reference: z.literal("NEXT_SESSION_OPEN"),
  entry_rank: z.int().min(1),
  hold_rank: z.int().min(1),
  max_positions: z.int().min(1),
  max_new_positions_per_decision: z.int().min(1),
  /** Absolute weight gap in NAV percentage points below which a line is not traded. */
  rebalance_band_pct_points: positiveDecString,
});

const Sizing = z.strictObject({
  weighting: z.literal("INVERSE_VOLATILITY"),
  max_weight_per_etf: ratioString.refine((s) => new Dec(s).gt(0), "must be greater than zero"),
  min_cash_weight: ratioString,
  annual_volatility_target: positiveDecString,
  /** At most `max_members` of a correlated cluster may be held simultaneously. */
  clusters: z.array(z.strictObject({ id: z.string().min(1), members: z.array(symbol).min(2), max_members: z.int().min(1) })).default([]),
  whole_shares_only: z.literal(true),
});

const CostTier = z.strictObject({
  commission_bps: decString,
  /** Per-symbol half spread in bps; `default` covers anything unlisted. */
  half_spread_bps: z.record(z.string(), decString),
  slippage_bps: decString,
  market_impact_bps: decString,
  delay_bars: z.int().min(0),
});

const Costs = z.strictObject({
  base: CostTier,
  adverse: CostTier,
  stress: CostTier,
  stress_multipliers: z.array(positiveDecString).min(1),
  delay_sensitivity_bars: z.array(z.int().min(0)).min(1),
  missing_data_rates: z.array(ratioString).min(1),
  max_participation_of_adv: ratioString.refine((s) => new Dec(s).gt(0), "must be greater than zero"),
});

const Boundaries = z.strictObject({
  registered_history_start: isoDateString,
  design: z.strictObject({ start: isoDateString, end: isoDateString }),
  holdout: z.strictObject({ start: isoDateString, end: isoDateString }),
  recent: z.strictObject({ start: isoDateString, end: isoDateString }),
  walk_forward: z.strictObject({
    window_years: z.int().min(1),
    step_months: z.int().min(1),
    purge_days: z.int().min(0),
    embargo_days: z.int().min(0),
  }),
});

const PassFail = z.strictObject({
  primary_metric: z.string().min(1),
  /** Minimum point estimate of the primary metric for a pass. */
  primary_threshold: decString,
  bootstrap_block_sessions: z.int().min(1),
  bootstrap_confidence: ratioString,
  /** Strategy max drawdown must be at or below this multiple of the primary benchmark's. */
  max_drawdown_ratio: positiveDecString,
  /** Fraction of sensitivity-grid members that must agree in sign. */
  min_grid_sign_agreement: ratioString,
  minimum_independent_decisions: z.int().min(1),
  /** Falsifier ids (F1..Fn) with the condition each encodes. */
  falsifiers: z.array(z.strictObject({ id: z.string().min(1), condition: z.string().min(1) })).min(1),
});

const Benchmarks = z.strictObject({
  primary: z.string().min(1),
  cash: z.string().min(1),
  exposure_matched: z.boolean(),
  volatility_controlled_primary: z.boolean(),
  equal_weight_risk_etfs: z.boolean(),
  secondary: z.array(z.string().min(1)).default([]),
});

const SensitivityGrid = z.strictObject({
  momentum: z.array(z.strictObject({ lookback_sessions: z.int().min(2), skip_sessions: z.int().min(0) })).min(1),
  trend_sma_sessions: z.array(z.int().min(2)).min(1),
  volatility_sessions: z.array(z.int().min(2)).min(1),
  ranks: z.array(z.strictObject({ entry: z.int().min(1), hold: z.int().min(1) })).min(1),
  annual_volatility_target: z.array(positiveDecString).min(1),
  rebalance_band_pct_points: z.array(positiveDecString).min(1),
});

export const CharterSchema = z.strictObject({
  strategy_id: strategyId,
  charter_version: semver,
  /** Path of the prose charter this file accompanies. */
  prose_charter: z.string().min(1),
  runtime_llm_in_signal: z.literal(false),
  arms: z.array(z.enum(["B0_PASSIVE", "B1_DETERMINISTIC"])).min(1),
  approval: ApprovalBlock,
  universe: Universe,
  posture: z.strictObject({
    long_only: z.literal(true),
    unlevered: z.literal(true),
    regular_session_only: z.literal(true),
    max_gross_exposure: ratioString,
  }),
  features: Features,
  rules: Rules,
  sizing: Sizing,
  costs: Costs,
  boundaries: Boundaries,
  benchmarks: Benchmarks,
  pass_fail: PassFail,
  sensitivity_grid: SensitivityGrid,
  tax_scenarios: z.array(z.enum(["pre_tax", "taxable_short_long_split", "tax_deferred"])).min(1),
  /** Section 23 of the prose charter, carried into every report. */
  reasons_it_may_not_work: z.array(z.string().min(1)).min(1),
  component_versions: z.strictObject({
    features: z.int().min(0),
    strategy_rules: z.int().min(0),
    portfolio_construction: z.int().min(0),
    risk_policy: z.int().min(0),
    cost_model: z.int().min(0),
  }),
});

export type Charter = z.infer<typeof CharterSchema>;
export type CharterInput = z.input<typeof CharterSchema>;

export class InvalidCharterError extends Error {
  readonly issues: string[];
  constructor(path: string, issues: string[]) {
    super(`Invalid charter ${path}: ${issues.join("; ")}`);
    this.name = "InvalidCharterError";
    this.issues = issues;
  }
}

export class CharterNotRegistrableError extends Error {
  readonly reasons: string[];
  constructor(strategyId: string, version: string, reasons: string[]) {
    super(`Charter ${strategyId} ${version} may not be registered: ${reasons.join("; ")}`);
    this.name = "CharterNotRegistrableError";
    this.reasons = reasons;
  }
}

/** Cross-field rules the field schemas cannot express. Returned as issue strings, never thrown here. */
function structuralIssues(c: Charter): string[] {
  const issues: string[] = [];
  if (c.rules.hold_rank < c.rules.entry_rank) issues.push("rules.hold_rank must be at or above rules.entry_rank (hysteresis widens, never narrows)");
  if (c.rules.max_positions !== c.rules.entry_rank) issues.push("rules.max_positions must equal rules.entry_rank: the entry rank is what bounds the book");
  if (c.features.momentum_skip_sessions >= c.features.momentum_lookback_sessions) issues.push("features.momentum_skip_sessions must be shorter than the lookback");
  const cap = new Dec(c.sizing.max_weight_per_etf);
  const minInvestable = new Dec(1).minus(c.sizing.min_cash_weight);
  if (cap.times(c.rules.entry_rank).lt(minInvestable)) {
    issues.push(`sizing.max_weight_per_etf ${c.sizing.max_weight_per_etf} x entry_rank ${c.rules.entry_rank} cannot reach 1 - min_cash_weight; the book could never be fully invested`);
  }
  if (new Dec(c.posture.max_gross_exposure).plus(c.sizing.min_cash_weight).gt(1)) issues.push("posture.max_gross_exposure + sizing.min_cash_weight must not exceed 1");
  if (c.universe.risk_etfs.includes(c.universe.cash_etf)) issues.push(`universe.cash_etf ${c.universe.cash_etf} must not also be a risk ETF`);
  const risk = new Set(c.universe.risk_etfs);
  for (const s of c.universe.look_through_flagged) if (!risk.has(s)) issues.push(`universe.look_through_flagged ${s} is not in risk_etfs`);
  for (const cd of c.universe.conditional) if (!risk.has(cd.symbol)) issues.push(`universe.conditional ${cd.symbol} is not in risk_etfs`);
  for (const cl of c.sizing.clusters) {
    for (const m of cl.members) if (!risk.has(m)) issues.push(`sizing.clusters.${cl.id} member ${m} is not in risk_etfs`);
    if (cl.max_members >= cl.members.length) issues.push(`sizing.clusters.${cl.id}.max_members ${cl.max_members} does not constrain a ${cl.members.length}-member cluster`);
  }
  const b = c.boundaries;
  if (b.design.start < b.registered_history_start) issues.push("boundaries.design.start precedes registered_history_start");
  if (b.design.end >= b.holdout.start) issues.push("boundaries.holdout must start after the design period ends");
  if (b.holdout.end >= b.recent.start) issues.push("boundaries.recent must start after the holdout ends");
  for (const [name, r] of [
    ["design", b.design],
    ["holdout", b.holdout],
    ["recent", b.recent],
  ] as const) {
    if (r.start > r.end) issues.push(`boundaries.${name}.start follows its end`);
  }
  for (const tier of ["base", "adverse", "stress"] as const) {
    if (!c.costs[tier].half_spread_bps["default"]) issues.push(`costs.${tier}.half_spread_bps needs a \`default\` entry`);
  }
  const gridRegistered =
    c.sensitivity_grid.momentum.some((m) => m.lookback_sessions === c.features.momentum_lookback_sessions && m.skip_sessions === c.features.momentum_skip_sessions) &&
    c.sensitivity_grid.trend_sma_sessions.includes(c.features.trend_sma_sessions) &&
    c.sensitivity_grid.volatility_sessions.includes(c.features.volatility_sessions) &&
    c.sensitivity_grid.ranks.some((r) => r.entry === c.rules.entry_rank && r.hold === c.rules.hold_rank) &&
    c.sensitivity_grid.annual_volatility_target.some((v) => new Dec(v).eq(c.sizing.annual_volatility_target)) &&
    c.sensitivity_grid.rebalance_band_pct_points.some((v) => new Dec(v).eq(c.rules.rebalance_band_pct_points));
  if (!gridRegistered) issues.push("the registered point must itself be a member of sensitivity_grid (protocol section 5.4)");
  return issues;
}

/** Parse and structurally validate. Throws InvalidCharterError; says nothing about approval. */
export function parseCharter(value: unknown, path = "<inline>"): Charter {
  const parsed = CharterSchema.safeParse(value);
  if (!parsed.success) throw new InvalidCharterError(path, parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`));
  const issues = structuralIssues(parsed.data);
  if (issues.length > 0) throw new InvalidCharterError(path, issues);
  return parsed.data;
}

export type LoadedCharter = {
  charter: Charter;
  /** sha256 of the canonical JSON of the parsed charter: what the experiment registration freezes. */
  charterHash: string;
  path: string;
};

/**
 * The hash covers the whole parsed charter including the approval block, so signing the charter changes the
 * hash. That is intended: an approved charter is a different artifact from the draft it came from.
 */
export function charterHash(charter: Charter): string {
  return `sha256:${hashJson(charter)}`;
}

export function loadCharterFromYaml(text: string, path = "<inline>"): LoadedCharter {
  let doc: unknown;
  try {
    doc = parseYaml(text) as unknown;
  } catch (e) {
    throw new InvalidCharterError(path, [`YAML parse failed: ${e instanceof Error ? e.message : String(e)}`]);
  }
  const charter = parseCharter(doc, path);
  return { charter, charterHash: charterHash(charter), path };
}

export function loadCharterFile(path: string): LoadedCharter {
  return loadCharterFromYaml(readFileSync(path, "utf8"), path);
}

/** Every reason this charter may not be frozen into an experiment. Empty means registrable. */
export function registrabilityReasons(c: Charter): string[] {
  const reasons: string[] = [];
  const a = c.approval;
  if (a.state !== "APPROVED") reasons.push(`approval.state is ${a.state}; only APPROVED may be registered`);
  if (a.approved_by === null) reasons.push("approval.approved_by is unsigned");
  if (a.approval_date === null) reasons.push("approval.approval_date is empty");
  if (a.code_commit === null) reasons.push("approval.code_commit is empty");
  if (a.approval_ref === null) reasons.push("approval.approval_ref is empty: the written owner decision must be citable");
  for (const d of a.open_decisions) if (d.resolution === null) reasons.push(`open decision ${d.id} is unresolved: ${d.question}`);
  for (const cd of c.universe.conditional) if (cd.admitted === null) reasons.push(`conditional universe member ${cd.symbol} is undecided: ${cd.condition}`);
  return reasons;
}

export function isRegistrable(c: Charter): boolean {
  return registrabilityReasons(c).length === 0;
}

/**
 * The gate. Call this before any code path that freezes a definition, opens a holdout, or computes a
 * registered result. A DRAFT charter can be loaded, inspected, and run against fixtures; it can never be
 * registered, which is what keeps unapproved numbers out of the evidence record.
 */
export function assertRegistrable(c: Charter): void {
  const reasons = registrabilityReasons(c);
  if (reasons.length > 0) throw new CharterNotRegistrableError(c.strategy_id, c.charter_version, reasons);
}

/**
 * The risk ETFs a run may hold: declared risk ETFs minus every conditional member that is not positively
 * admitted. An undecided condition excludes the member (fail closed), so a DRAFT charter's universe is the
 * conservative one and admitting XLE later is a charter edit with a new hash.
 */
export function admittedRiskEtfs(c: Charter): string[] {
  const blocked = new Set(c.universe.conditional.filter((cd) => cd.admitted !== true).map((cd) => cd.symbol));
  return c.universe.risk_etfs.filter((s) => !blocked.has(s));
}

/** Risk ETFs plus the cash leg, sorted: the universe snapshot's member list. */
export function charterUniverseMembers(c: Charter): string[] {
  return [...admittedRiskEtfs(c), c.universe.cash_etf].sort();
}

export type CharterDateRange = { start: IsoDate; end: IsoDate };

export function charterRange(c: Charter, segment: "design" | "holdout" | "recent"): CharterDateRange {
  const r = c.boundaries[segment];
  return { start: isoDate(r.start), end: isoDate(r.end) };
}
