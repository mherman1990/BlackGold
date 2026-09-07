import { Dec, type Db, type UtcInstant } from "@blackgold/shared";

/**
 * Append-only archive of every runtime-LLM call, and the budget spend derived from it
 * (docs/PRODUCT_SPEC.md section 6, "Archive everything" and "Budgets"; threat model - the record is already
 * redacted: it carries no packet content, no secret, and no household dollar).
 *
 * This module owns its own row shape rather than importing `ModelCallRecord` from the model layer, so the
 * research layer never depends on the model layer (the model layer imports research, not the other way). The
 * caller maps a `ModelCallRecord` onto {@link ModelCallLogRow} at the seam. Spend is summed with decimal
 * arithmetic over a day or a month so a running budget survives a process restart.
 */

export type ModelCallLogRow = {
  at: UtcInstant;
  strategyVersion: string;
  candidateId: string;
  modelId: string;
  servedModelId?: string;
  promptVersion: string;
  promptHash: string;
  schemaHash: string;
  packetHash: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /** Decimal string. The LLM API cost of the call, never a household or sleeve dollar amount. */
  costUsd: string;
  latencyMs: number;
  attempts: number;
  outcome: "assessed" | "abstained";
  abstainCode?: string;
  validation: string;
  contaminationLabel?: string;
  runMode?: string;
};

const INSERT = `INSERT INTO model_calls (
  at, strategy_version, candidate_id, model_id, served_model_id, prompt_version, prompt_hash, schema_hash,
  packet_hash, input_tokens, output_tokens, cache_read_input_tokens, cost_usd, latency_ms, attempts, outcome,
  abstain_code, validation, contamination_label, run_mode
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export function recordModelCall(db: Db, row: ModelCallLogRow): void {
  db.prepare(INSERT).run(
    row.at,
    row.strategyVersion,
    row.candidateId,
    row.modelId,
    row.servedModelId ?? null,
    row.promptVersion,
    row.promptHash,
    row.schemaHash,
    row.packetHash,
    row.inputTokens,
    row.outputTokens,
    row.cacheReadInputTokens,
    row.costUsd,
    row.latencyMs,
    row.attempts,
    row.outcome,
    row.abstainCode ?? null,
    row.validation,
    row.contaminationLabel ?? null,
    row.runMode ?? null,
  );
}

export type ModelCallSpend = { spentTodayUsd: Dec; spentMonthUsd: Dec };

function sumCost(rows: readonly { cost_usd: string }[]): Dec {
  return rows.reduce((acc, r) => acc.plus(new Dec(r.cost_usd)), new Dec(0));
}

/**
 * Decimal spend for the UTC calendar day and month containing `now`. Costs are TEXT decimals summed in code
 * (SQLite cannot sum decimal strings), so no binary float enters a budget total.
 */
export function modelCallSpend(db: Db, now: UtcInstant): ModelCallSpend {
  const day = now.slice(0, 10); // YYYY-MM-DD
  const month = now.slice(0, 7); // YYYY-MM
  const today = db.prepare("SELECT cost_usd FROM model_calls WHERE substr(at,1,10) = ?").all(day) as { cost_usd: string }[];
  const monthRows = db.prepare("SELECT cost_usd FROM model_calls WHERE substr(at,1,7) = ?").all(month) as { cost_usd: string }[];
  return { spentTodayUsd: sumCost(today), spentMonthUsd: sumCost(monthRows) };
}

/** Total number of archived calls, for the status surface and tests. */
export function modelCallCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM model_calls").get() as { n: number }).n;
}
