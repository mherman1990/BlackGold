import { z } from "zod";
import { ARMS, hashJson, nowUtc, utc, type Db, type UtcInstant } from "@blackgold/shared";
import { decString, isoDateString, ratioString } from "../config/schema.ts";
import { blocksPromotionEvidence } from "../data/quality.ts";
import type { PointInTimeRepository } from "../data/pit/repository.ts";
import type { Ledger } from "../ledger/ledger.ts";

/**
 * Experiment registry (docs/EXPERIMENT_PROTOCOL.md sections 2-4).
 *
 * Registration freezes a definition and hashes it. Viewing results is logged once and makes any change a
 * new experiment with a parent. The holdout opens once, after review, with a reason, logged to the ledger.
 * The trial ledger is append-only and is the denominator for multiple-testing statistics. Runs labelled
 * SURVIVORSHIP_BIASED or OPTIMISTIC_DELAY can never be cited as promotion evidence; the registry refuses.
 */

const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

const CostScenario = z.strictObject({
  commission_bps: decString,
  half_spread_bps: decString,
  slippage_bps: decString,
  delay_bars: z.int().min(0),
});

const DateRange = z.strictObject({ start: isoDateString, end: isoDateString }).refine((r) => r.start <= r.end, "start must not follow end");

export const ExperimentDefinitionSchema = z.strictObject({
  charter: z.strictObject({
    strategy_id: z.string().min(1),
    charter_version: z.string().min(1),
    charter_hash: z.string().regex(SHA256_PREFIXED, "charter_hash must be sha256:<64 hex>"),
    owner_approval_ref: z.string().min(1).optional(),
  }),
  code: z.strictObject({
    repo: z.string().min(1),
    commit: z.string().regex(COMMIT_RE, "commit must be 7-40 hex characters"),
    dirty_tree_allowed: z.boolean().default(false),
  }),
  data: z.strictObject({
    snapshots: z.array(z.strictObject({ dataset: z.string().min(1), snapshot_id: z.string().min(1) })).min(1),
    coverage_report_id: z.string().min(1).optional(),
    /** Per-source processing delay used by every asOf read in the run. Zero labels the run OPTIMISTIC_DELAY. */
    processing_delay_ms: z.int().min(0),
  }),
  versions: z.strictObject({
    features: z.int().min(0),
    strategy_rules: z.int().min(0),
    portfolio_construction: z.int().min(0),
    risk_policy: z.int().min(0),
    cost_model: z.int().min(0),
  }),
  model: z
    .strictObject({
      provider: z.string().min(1),
      model_id: z.string().min(1),
      prompt_hash: z.string().regex(SHA256_PREFIXED),
      schema_hash: z.string().regex(SHA256_PREFIXED),
      tool_set: z.array(z.string()).default([]),
      decoding: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      preprocessor_version: z.int().min(0),
      contamination_label: z.literal("HISTORICAL_REPLAY_CONTAMINATED"),
    })
    .optional(),
  arms: z.array(z.enum(ARMS)).min(1),
  search_space: z.strictObject({
    grid: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()])).min(1)),
    sampling: z.enum(["full_grid", "random", "single"]),
    trial_count: z.int().min(1),
  }),
  boundaries: z.strictObject({
    train: DateRange,
    validation: DateRange,
    walk_forward: z.strictObject({
      window_years: z.int().min(1),
      step_months: z.int().min(1),
      purge_days: z.int().min(0),
      embargo_days: z.int().min(0),
    }),
    holdout: z
      .strictObject({ start: isoDateString, end: isoDateString, opened: z.boolean() })
      .refine((r) => r.start <= r.end, "start must not follow end"),
  }),
  metrics: z.strictObject({ primary: z.string().min(1), secondary: z.array(z.string().min(1)) }),
  costs: z.strictObject({
    base: CostScenario,
    adverse: CostScenario,
    stress_multipliers: z.array(decString).min(1),
    delay_sensitivity_bars: z.array(z.int().min(0)).min(1),
    missing_data_rates: z.array(ratioString).min(1),
  }),
  benchmarks: z.strictObject({
    primary: z.string().min(1),
    exposure_matched: z.strictObject({ equity: z.string().min(1), cash: z.string().min(1) }).optional(),
    secondary: z.array(z.string().min(1)),
  }),
  pass_fail: z.strictObject({
    primary_condition: z.string().min(1),
    robustness_conditions: z.array(z.string().min(1)),
    minimum_independent_decisions: z.int().min(1),
  }),
  tax_scenarios: z.array(z.enum(["pre_tax", "taxable_short_long_split", "tax_deferred"])).min(1),
});

export type ExperimentDefinition = z.infer<typeof ExperimentDefinitionSchema>;
export type ExperimentDefinitionInput = z.input<typeof ExperimentDefinitionSchema>;

export type ExperimentRecord = {
  experimentId: string;
  registeredAt: UtcInstant;
  registeredBy: string;
  parentExperimentId: string | null;
  supersedesReason: string | null;
  definition: ExperimentDefinition;
  definitionHash: string;
  resultsViewedAt: UtcInstant | null;
  holdoutOpenedAt: UtcInstant | null;
  holdoutOpenedBy: string | null;
  holdoutOpenedReason: string | null;
  /** Eligibility fixed at registration: false when any label bars promotion evidence. */
  promotionEvidenceAllowed: boolean;
  promotionEvidenceAt: UtcInstant | null;
  promotionEvidenceBy: string | null;
  labels: string[];
};

export type TrialInput = {
  experimentId: string;
  arm: string;
  split: string;
  params: Record<string, unknown>;
  metrics: Record<string, unknown>;
  costScenario: string;
  labels?: readonly string[];
  codeCommit: string;
  snapshotIds: readonly string[];
  resultHash: string;
  runStarted: UtcInstant;
  runFinished: UtcInstant;
};

export type TrialRow = Omit<TrialInput, "labels" | "snapshotIds"> & { trialId: string; labels: string[]; snapshotIds: string[] };

export class InvalidExperimentDefinitionError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid experiment definition: ${issues.join("; ")}`);
    this.name = "InvalidExperimentDefinitionError";
    this.issues = issues;
  }
}
export class UnknownExperimentError extends Error {
  constructor(id: string) {
    super(`Unknown experiment ${id}`);
    this.name = "UnknownExperimentError";
  }
}
export class ParentRequiredError extends Error {
  constructor(strategyId: string, viewed: string[]) {
    super(`Results of ${viewed.join(", ")} for charter ${strategyId} have been viewed; a new registration must name a parent_experiment_id`);
    this.name = "ParentRequiredError";
  }
}
export class DirtyTreeError extends Error {
  constructor() {
    super("code.dirty_tree_allowed=true is refused: experiments run from a committed tree only");
    this.name = "DirtyTreeError";
  }
}
export class HoldoutAlreadyOpenedError extends Error {
  constructor(id: string, at: UtcInstant) {
    super(`Holdout of ${id} was already opened at ${at}; it opens once`);
    this.name = "HoldoutAlreadyOpenedError";
  }
}
export class HoldoutBeforeReviewError extends Error {
  constructor(id: string) {
    super(`Holdout of ${id} cannot open before validation and walk-forward results are marked viewed`);
    this.name = "HoldoutBeforeReviewError";
  }
}
export class HoldoutInheritanceError extends Error {
  constructor(parentId: string) {
    super(`Parent ${parentId} opened its holdout; the descendant must declare a later holdout or set boundaries.holdout.opened=true`);
    this.name = "HoldoutInheritanceError";
  }
}
export class PromotionEvidenceRefusedError extends Error {
  constructor(id: string, reason: string) {
    super(`Experiment ${id} cannot be promotion evidence: ${reason}`);
    this.name = "PromotionEvidenceRefusedError";
  }
}
export class FrozenInputMismatchError extends Error {
  constructor(id: string, detail: string) {
    super(`Trial for ${id} does not match the frozen registration: ${detail}`);
    this.name = "FrozenInputMismatchError";
  }
}

type ExperimentRowDb = {
  experiment_id: string;
  registered_at: string;
  registered_by: string;
  parent_experiment_id: string | null;
  supersedes_reason: string | null;
  definition_json: string;
  definition_hash: string;
  results_viewed_at: string | null;
  holdout_opened_at: string | null;
  holdout_opened_by: string | null;
  holdout_opened_reason: string | null;
  promotion_evidence_allowed: number;
  promotion_evidence_at: string | null;
  promotion_evidence_by: string | null;
  labels_json: string;
};

type TrialRowDb = {
  trial_id: string;
  experiment_id: string;
  arm: string;
  split: string;
  params_json: string;
  metrics_json: string;
  cost_scenario: string;
  labels_json: string;
  code_commit: string;
  snapshot_ids_json: string;
  result_hash: string;
  run_started: string;
  run_finished: string;
};

function optInstant(v: string | null): UtcInstant | null {
  return v === null ? null : utc(v);
}

function rowToRecord(r: ExperimentRowDb): ExperimentRecord {
  return {
    experimentId: r.experiment_id,
    registeredAt: utc(r.registered_at),
    registeredBy: r.registered_by,
    parentExperimentId: r.parent_experiment_id,
    supersedesReason: r.supersedes_reason,
    definition: ExperimentDefinitionSchema.parse(JSON.parse(r.definition_json)),
    definitionHash: r.definition_hash,
    resultsViewedAt: optInstant(r.results_viewed_at),
    holdoutOpenedAt: optInstant(r.holdout_opened_at),
    holdoutOpenedBy: r.holdout_opened_by,
    holdoutOpenedReason: r.holdout_opened_reason,
    promotionEvidenceAllowed: r.promotion_evidence_allowed === 1,
    promotionEvidenceAt: optInstant(r.promotion_evidence_at),
    promotionEvidenceBy: r.promotion_evidence_by,
    labels: JSON.parse(r.labels_json) as string[],
  };
}

function rowToTrial(r: TrialRowDb): TrialRow {
  return {
    trialId: r.trial_id,
    experimentId: r.experiment_id,
    arm: r.arm,
    split: r.split,
    params: JSON.parse(r.params_json) as Record<string, unknown>,
    metrics: JSON.parse(r.metrics_json) as Record<string, unknown>,
    costScenario: r.cost_scenario,
    labels: JSON.parse(r.labels_json) as string[],
    codeCommit: r.code_commit,
    snapshotIds: JSON.parse(r.snapshot_ids_json) as string[],
    resultHash: r.result_hash,
    runStarted: utc(r.run_started),
    runFinished: utc(r.run_finished),
  };
}

export function definitionHash(def: ExperimentDefinition): string {
  return `sha256:${hashJson(def)}`;
}

export class ExperimentRegistry {
  private readonly db: Db;
  private readonly pit: PointInTimeRepository;
  private readonly ledger: Ledger;
  private readonly clock: () => number;

  constructor(db: Db, pit: PointInTimeRepository, ledger: Ledger, opts: { clock?: () => number } = {}) {
    this.db = db;
    this.pit = pit;
    this.ledger = ledger;
    this.clock = opts.clock ?? Date.now;
  }

  /** Validate and freeze a definition. Throws before writing anything when any rule fails. */
  register(
    input: ExperimentDefinitionInput,
    opts: { registeredBy: string; parentExperimentId?: string; supersedesReason?: string; labels?: readonly string[] },
  ): ExperimentRecord {
    const parsed = ExperimentDefinitionSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidExperimentDefinitionError(parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`));
    }
    const def = parsed.data;
    if (def.code.dirty_tree_allowed) throw new DirtyTreeError();
    if (opts.registeredBy.length === 0) throw new TypeError("registeredBy is required");
    for (const s of def.data.snapshots) this.pit.snapshot(s.snapshot_id); // throws UnknownSnapshotError

    return this.db.transaction(() => {
      const parent = opts.parentExperimentId === undefined ? undefined : this.get(opts.parentExperimentId);
      if (!parent) {
        const viewed = (
          this.db
            .prepare("SELECT experiment_id, definition_json FROM experiments WHERE results_viewed_at IS NOT NULL ORDER BY experiment_id")
            .all() as { experiment_id: string; definition_json: string }[]
        ).filter((r) => (JSON.parse(r.definition_json) as { charter: { strategy_id: string } }).charter.strategy_id === def.charter.strategy_id);
        if (viewed.length > 0) throw new ParentRequiredError(def.charter.strategy_id, viewed.map((v) => v.experiment_id));
      } else if (parent.holdoutOpenedAt !== null) {
        const parentEnd = parent.definition.boundaries.holdout.end;
        const declaresLater = def.boundaries.holdout.start > parentEnd;
        if (!declaresLater && !def.boundaries.holdout.opened) throw new HoldoutInheritanceError(parent.experimentId);
      }

      const labels = new Set<string>(opts.labels ?? []);
      if (def.data.processing_delay_ms === 0) labels.add("OPTIMISTIC_DELAY");
      const labelList = [...labels].sort();
      const blocked = blocksPromotionEvidence(labelList);
      const registeredAt = nowUtc(this.clock);
      const year = registeredAt.slice(0, 4);
      const n = (this.db.prepare("SELECT count(*) AS n FROM experiments WHERE experiment_id LIKE ?").get(`EXP-${year}-%`) as { n: number }).n;
      const experimentId = `EXP-${year}-${String(n + 1).padStart(4, "0")}`;
      const hash = definitionHash(def);
      this.db
        .prepare(
          `INSERT INTO experiments (experiment_id, registered_at, registered_by, parent_experiment_id, supersedes_reason, definition_json,
             definition_hash, promotion_evidence_allowed, labels_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          experimentId,
          registeredAt,
          opts.registeredBy,
          opts.parentExperimentId ?? null,
          opts.supersedesReason ?? null,
          JSON.stringify(def),
          hash,
          blocked.length === 0 ? 1 : 0,
          JSON.stringify(labelList),
        );
      this.ledger.append(
        "experiment.registered",
        {
          experimentId,
          definitionHash: hash,
          registeredBy: opts.registeredBy,
          parentExperimentId: opts.parentExperimentId ?? null,
          supersedesReason: opts.supersedesReason ?? null,
          strategyId: def.charter.strategy_id,
          charterVersion: def.charter.charter_version,
          codeCommit: def.code.commit,
          snapshotIds: def.data.snapshots.map((s) => s.snapshot_id),
          labels: labelList,
          promotionEvidenceAllowed: blocked.length === 0,
        },
        registeredAt,
      );
      return this.get(experimentId);
    });
  }

  get(experimentId: string): ExperimentRecord {
    const row = this.db.prepare("SELECT * FROM experiments WHERE experiment_id = ?").get(experimentId) as ExperimentRowDb | undefined;
    if (!row) throw new UnknownExperimentError(experimentId);
    return rowToRecord(row);
  }

  list(): ExperimentRecord[] {
    return (this.db.prepare("SELECT * FROM experiments ORDER BY registered_at, experiment_id").all() as ExperimentRowDb[]).map(rowToRecord);
  }

  /** Log the first view of any result. Idempotent: a second call returns the existing record and logs nothing. */
  markResultsViewed(experimentId: string, opts: { viewedBy: string }, at: UtcInstant = nowUtc(this.clock)): ExperimentRecord {
    return this.db.transaction(() => {
      const rec = this.get(experimentId);
      if (rec.resultsViewedAt !== null) return rec;
      this.db.prepare("UPDATE experiments SET results_viewed_at = ? WHERE experiment_id = ?").run(utc(at), experimentId);
      this.ledger.append("experiment.results_viewed", { experimentId, viewedBy: opts.viewedBy }, at);
      return this.get(experimentId);
    });
  }

  /** Privileged, once only, after review, with a reason. Logged to the ledger. */
  openHoldout(experimentId: string, opts: { reason: string; requestedBy: string }, at: UtcInstant = nowUtc(this.clock)): ExperimentRecord {
    if (opts.reason.trim().length === 0) throw new TypeError("a written reason is required to open the holdout");
    if (opts.requestedBy.length === 0) throw new TypeError("requestedBy is required");
    return this.db.transaction(() => {
      const rec = this.get(experimentId);
      if (rec.holdoutOpenedAt !== null) throw new HoldoutAlreadyOpenedError(experimentId, rec.holdoutOpenedAt);
      if (rec.resultsViewedAt === null) throw new HoldoutBeforeReviewError(experimentId);
      this.db
        .prepare("UPDATE experiments SET holdout_opened_at = ?, holdout_opened_by = ?, holdout_opened_reason = ? WHERE experiment_id = ?")
        .run(utc(at), opts.requestedBy, opts.reason, experimentId);
      this.ledger.append(
        "experiment.holdout_opened",
        { experimentId, requestedBy: opts.requestedBy, reason: opts.reason, holdout: rec.definition.boundaries.holdout },
        at,
      );
      return this.get(experimentId);
    });
  }

  /**
   * Cite (or withdraw) the experiment as promotion evidence. Refused when any label bars it (SURVIVORSHIP_BIASED,
   * OPTIMISTIC_DELAY, ...) or when the holdout was never opened: historical evidence without an out-of-sample
   * confirmation is tier 1 only. Withdrawing is always allowed.
   */
  setPromotionEvidence(experimentId: string, value: boolean, opts: { requestedBy: string }, at: UtcInstant = nowUtc(this.clock)): ExperimentRecord {
    return this.db.transaction(() => {
      const rec = this.get(experimentId);
      if (value) {
        // Labels attach at registration and per trial (a snapshot or asOf read can label a single run
        // SURVIVORSHIP_BIASED or OPTIMISTIC_DELAY). Any blocking label anywhere makes the whole experiment
        // exploratory: promotion evidence is refused when one trial carries one.
        const trialLabels = (this.db.prepare("SELECT labels_json FROM trial_ledger WHERE experiment_id = ?").all(experimentId) as { labels_json: string }[]).flatMap(
          (r) => JSON.parse(r.labels_json) as string[],
        );
        const blocked = [...new Set(blocksPromotionEvidence([...rec.labels, ...trialLabels]))].sort();
        if (blocked.length > 0 || !rec.promotionEvidenceAllowed) {
          throw new PromotionEvidenceRefusedError(experimentId, `labels ${blocked.length > 0 ? blocked.join(", ") : rec.labels.join(", ")} make the run exploratory only`);
        }
        if (rec.holdoutOpenedAt === null) throw new PromotionEvidenceRefusedError(experimentId, "holdout was never opened");
        this.db.prepare("UPDATE experiments SET promotion_evidence_at = ?, promotion_evidence_by = ? WHERE experiment_id = ?").run(utc(at), opts.requestedBy, experimentId);
      } else {
        this.db.prepare("UPDATE experiments SET promotion_evidence_at = NULL, promotion_evidence_by = NULL WHERE experiment_id = ?").run(experimentId);
      }
      this.ledger.append("experiment.promotion_evidence_set", { experimentId, value, requestedBy: opts.requestedBy }, at);
      return this.get(experimentId);
    });
  }

  /**
   * Append one evaluated cell. The trial must match the frozen registration: same commit, an arm the
   * definition declares, and snapshot ids drawn from the registered set. Labels are the union of the
   * experiment's labels and the row's own.
   */
  recordTrial(t: TrialInput): TrialRow {
    if (!COMMIT_RE.test(t.codeCommit)) throw new TypeError("codeCommit must be 7-40 hex characters");
    if (!SHA256_PREFIXED.test(t.resultHash)) throw new TypeError("resultHash must be sha256:<64 hex>");
    const started = utc(t.runStarted);
    const finished = utc(t.runFinished);
    if (finished < started) throw new RangeError("runFinished precedes runStarted");
    return this.db.transaction(() => {
      const rec = this.get(t.experimentId);
      if (t.codeCommit !== rec.definition.code.commit) throw new FrozenInputMismatchError(t.experimentId, `commit ${t.codeCommit} != ${rec.definition.code.commit}`);
      if (!(rec.definition.arms as readonly string[]).includes(t.arm)) throw new FrozenInputMismatchError(t.experimentId, `arm ${t.arm} not declared`);
      const declared = new Set(rec.definition.data.snapshots.map((s) => s.snapshot_id));
      for (const id of t.snapshotIds) if (!declared.has(id)) throw new FrozenInputMismatchError(t.experimentId, `snapshot ${id} not registered`);
      if (t.snapshotIds.length === 0) throw new FrozenInputMismatchError(t.experimentId, "a trial must cite at least one snapshot");
      const n = (this.db.prepare("SELECT count(*) AS n FROM trial_ledger WHERE experiment_id = ?").get(t.experimentId) as { n: number }).n;
      const trialId = `${t.experimentId}/t-${String(n + 1).padStart(3, "0")}`;
      const labels = [...new Set([...rec.labels, ...(t.labels ?? [])])].sort();
      const snapshotIds = [...t.snapshotIds];
      this.db
        .prepare(
          `INSERT INTO trial_ledger (trial_id, experiment_id, arm, split, params_json, metrics_json, cost_scenario, labels_json, code_commit,
             snapshot_ids_json, result_hash, run_started, run_finished)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trialId,
          t.experimentId,
          t.arm,
          t.split,
          JSON.stringify(t.params),
          JSON.stringify(t.metrics),
          t.costScenario,
          JSON.stringify(labels),
          t.codeCommit,
          JSON.stringify(snapshotIds),
          t.resultHash,
          started,
          finished,
        );
      this.ledger.append("experiment.trial_recorded", { experimentId: t.experimentId, trialId, arm: t.arm, split: t.split, resultHash: t.resultHash, labels }, finished);
      return { ...t, trialId, labels, snapshotIds, runStarted: started, runFinished: finished };
    });
  }

  trials(experimentId: string): TrialRow[] {
    this.get(experimentId);
    return (this.db.prepare("SELECT * FROM trial_ledger WHERE experiment_id = ? ORDER BY trial_id").all(experimentId) as TrialRowDb[]).map(rowToTrial);
  }

  /** Trials evaluated across the whole parent chain: the multiple-testing denominator (protocol section 3). */
  cumulativeTrialCount(experimentId: string): number {
    let total = 0;
    const seen = new Set<string>();
    let cursor: string | null = experimentId;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const rec = this.get(cursor);
      total += (this.db.prepare("SELECT count(*) AS n FROM trial_ledger WHERE experiment_id = ?").get(cursor) as { n: number }).n;
      cursor = rec.parentExperimentId;
    }
    return total;
  }
}
