import { Dec, sha256Hex } from "@blackgold/shared";
import {
  assessmentSchemaHash,
  researchAssessmentJsonSchema,
  validateAssessment,
  type ResearchAssessment,
} from "../research/assessment.ts";
import { packetSourceIds, sealPacket, type EvidencePacket } from "../research/packet.ts";
import { ModelUnavailableError, type ModelAdapter, type ModelRequest } from "./adapter.ts";

/**
 * Deterministic orchestration around a {@link ModelAdapter} (docs/PRODUCT_SPEC.md section 6, model-operations
 * table; threat model T-04/T-07/T-08). Turns a sealed packet into either a validated assessment or a safe
 * abstention, and records every call. Every failure mode ends in an abstention, never an exception that could
 * escape into a decision path: an unavailable or slow provider, a silent model swap, invalid or uncited
 * output, or an exhausted budget all abstain. Risk and reconciliation never depend on this returning an
 * assessment.
 */

export type AbstainCode =
  | "BUDGET_EXCEEDED"
  | "CIRCUIT_OPEN"
  | "MODEL_UNAVAILABLE"
  | "DEADLINE_EXCEEDED"
  | "MODEL_ID_MISMATCH"
  | "INVALID_OUTPUT"
  | "MODEL_ABSTAINED";

export type ModelCallRecord = {
  modelId: string;
  servedModelId?: string;
  promptVersion: string;
  promptHash: string;
  schemaHash: string;
  packetHash: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /** Decimal string. */
  costUsd: string;
  latencyMs: number;
  attempts: number;
  outcome: "assessed" | "abstained";
  abstainCode?: AbstainCode;
  validation: "valid" | "invalid" | "abstained" | "not_reached";
};

export type AssessResult =
  | { outcome: "assessed"; assessment: ResearchAssessment; record: ModelCallRecord }
  | { outcome: "abstained"; code: AbstainCode; reason: string; record: ModelCallRecord };

/**
 * A per-model-entry circuit breaker. Consecutive failures (unavailable, deadline, silent swap, or invalid
 * output) trip it open; a clean success or clean abstention closes it. While open, the model is not called.
 */
export class CircuitBreaker {
  private failures = 0;
  private open = false;
  private readonly threshold: number;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  isOpen(): boolean {
    return this.open;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.open = false;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.open = true;
  }
}

/** Current spend against the configured budgets. All amounts are decimal, never binary float. */
export type BudgetState = {
  perCallUsd: Dec;
  perDayUsd: Dec;
  perMonthUsd: Dec;
  spentTodayUsd: Dec;
  spentMonthUsd: Dec;
};

/** Per-million-token prices from the capability manifest, dated. Decimal, never float. */
export type Pricing = {
  inputPerMTokUsd: Dec;
  outputPerMTokUsd: Dec;
  cachedInputPerMTokUsd: Dec;
};

const PER_MILLION = new Dec(1_000_000);

function usageCost(inputTokens: number, outputTokens: number, cacheReadInputTokens: number, pricing: Pricing): Dec {
  return new Dec(inputTokens)
    .div(PER_MILLION)
    .mul(pricing.inputPerMTokUsd)
    .plus(new Dec(outputTokens).div(PER_MILLION).mul(pricing.outputPerMTokUsd))
    .plus(new Dec(cacheReadInputTokens).div(PER_MILLION).mul(pricing.cachedInputPerMTokUsd));
}

export type AssessOptions = {
  adapter: ModelAdapter;
  packet: EvidencePacket;
  prompt: { version: string; text: string };
  /** Factor set code computed for this candidate; the model's factorsTouched must match it exactly. */
  deterministicFactors: ReadonlySet<string>;
  deadlineMs: number;
  /** Total attempts including the first. */
  maxAttempts: number;
  breaker: CircuitBreaker;
  budget: BudgetState;
  pricing: Pricing;
};

type RaceOutcome<T> = { timedOut: false; value: T } | { timedOut: true };

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<RaceOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RaceOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([promise.then((value): RaceOutcome<T> => ({ timedOut: false, value })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runAssessment(opts: AssessOptions): Promise<AssessResult> {
  const { adapter, packet, prompt, deterministicFactors, deadlineMs, maxAttempts, breaker, budget, pricing } = opts;
  const promptHash = `sha256:${sha256Hex(prompt.text)}`;
  const schemaHash = assessmentSchemaHash();

  const baseRecord: ModelCallRecord = {
    modelId: adapter.modelId,
    promptVersion: prompt.version,
    promptHash,
    schemaHash,
    packetHash: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: "0",
    latencyMs: 0,
    attempts: 0,
    outcome: "abstained",
    validation: "not_reached",
  };

  const abstain = (code: AbstainCode, reason: string, patch: Partial<ModelCallRecord> = {}): AssessResult => ({
    outcome: "abstained",
    code,
    reason,
    record: { ...baseRecord, ...patch, outcome: "abstained", abstainCode: code },
  });

  // Budgets are checked before any call: exceeding one stops new analysis, never risk or reconciliation.
  if (budget.spentTodayUsd.gte(budget.perDayUsd) || budget.spentMonthUsd.gte(budget.perMonthUsd)) {
    return abstain("BUDGET_EXCEEDED", "daily or monthly LLM budget is exhausted");
  }
  if (breaker.isOpen()) {
    return abstain("CIRCUIT_OPEN", "the model circuit breaker is open after repeated failures");
  }

  const sealed = sealPacket(packet);
  const request: ModelRequest = {
    packetJson: sealed.json,
    packetHash: sealed.hash,
    promptText: prompt.text,
    promptVersion: prompt.version,
    outputSchema: researchAssessmentJsonSchema(),
    deadlineMs,
  };

  let attempts = 0;
  let lastFailure: { code: AbstainCode; reason: string } | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    let raced: RaceOutcome<Awaited<ReturnType<ModelAdapter["complete"]>>>;
    try {
      raced = await withDeadline(adapter.complete(request), deadlineMs);
    } catch (error) {
      if (error instanceof ModelUnavailableError) {
        breaker.recordFailure();
        lastFailure = { code: "MODEL_UNAVAILABLE", reason: error.message };
        continue;
      }
      throw error; // A genuine bug must surface, not be masked as an abstention.
    }
    if (raced.timedOut) {
      breaker.recordFailure();
      lastFailure = { code: "DEADLINE_EXCEEDED", reason: `provider did not respond within ${deadlineMs}ms` };
      continue;
    }

    const response = raced.value;
    const cost = usageCost(response.usage.inputTokens, response.usage.outputTokens, response.usage.cacheReadInputTokens, pricing);
    const telemetry: Partial<ModelCallRecord> = {
      packetHash: sealed.hash,
      servedModelId: response.servedModelId,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadInputTokens: response.usage.cacheReadInputTokens,
      costUsd: cost.toString(),
      latencyMs: response.latencyMs,
      attempts,
    };

    // No silent fallback: the served model must be the pinned one.
    if (response.servedModelId !== adapter.modelId) {
      breaker.recordFailure();
      return abstain(
        "MODEL_ID_MISMATCH",
        `provider served ${response.servedModelId}, expected the pinned ${adapter.modelId}`,
        { ...telemetry, validation: "not_reached" },
      );
    }

    const validation = validateAssessment(response.raw, { packetSourceIds: packetSourceIds(packet), deterministicFactors });
    if (!validation.ok) {
      breaker.recordFailure();
      return abstain("INVALID_OUTPUT", `schema/citation/factor validation failed: ${validation.reason}`, {
        ...telemetry,
        validation: "invalid",
      });
    }
    if (validation.abstained) {
      breaker.recordSuccess(); // a clean, well-formed abstention is not a provider failure
      return abstain("MODEL_ABSTAINED", validation.assessment.abstainReason ?? "model abstained", {
        ...telemetry,
        validation: "abstained",
      });
    }

    breaker.recordSuccess();
    return {
      outcome: "assessed",
      assessment: validation.assessment,
      record: { ...baseRecord, ...telemetry, outcome: "assessed", validation: "valid" },
    };
  }

  const failure = lastFailure ?? { code: "MODEL_UNAVAILABLE" as const, reason: "no attempt succeeded" };
  return abstain(failure.code, failure.reason, { attempts });
}
