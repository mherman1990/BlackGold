/**
 * The narrow provider boundary (docs/PRODUCT_SPEC.md section 6, "ModelAdapter and capability manifest").
 *
 * The research layer talks only to this interface, never to a provider SDK. An adapter takes a sealed packet
 * plus the output schema and returns raw structured output with telemetry; it does NOT validate the schema,
 * verify citations, enforce budgets, or decide to abstain. All of that is the deterministic orchestration in
 * `assess.ts`, so the safety logic is provider-agnostic and testable with no credentials. A real provider
 * implementation is the sole module allowed to reference a provider SDK/host, and is deferred to a later PR
 * with its own review of the egress change (today `data/http.ts` is policy-forbidden from issuing a POST).
 */

export type ModelRequest = {
  /** The sealed packet's canonical JSON - exactly what is sent to the provider. */
  packetJson: string;
  packetHash: string;
  /** Assembled instruction/system prompt (already free of secrets and household values). */
  promptText: string;
  promptVersion: string;
  /** JSON Schema (draft 2020-12) the provider must produce structured output against. */
  outputSchema: Record<string, unknown>;
  /** Hard wall-clock ceiling in milliseconds for the provider call. */
  deadlineMs: number;
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
};

export type ModelResponse = {
  /** The provider's structured output, unvalidated and therefore untrusted. */
  raw: unknown;
  usage: ModelUsage;
  latencyMs: number;
  /** The model id the provider actually served. Must equal the pinned id or the call abstains (no silent fallback). */
  servedModelId: string;
};

/** A transient provider failure (outage, rate limit, 5xx). The orchestration retries then abstains. */
export class ModelUnavailableError extends Error {
  constructor(reason: string) {
    super(`Model provider unavailable: ${reason}`);
    this.name = "ModelUnavailableError";
  }
}

export interface ModelAdapter {
  /** The pinned model snapshot id this adapter is configured for. */
  readonly modelId: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

const ZERO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };

export type StubBehavior = {
  /** Fixed raw output, or a function of the request (e.g. to echo packet-derived citations). */
  raw?: unknown;
  respond?: (request: ModelRequest) => unknown;
  usage?: Partial<ModelUsage>;
  latencyMs?: number;
  /** Real async delay before resolving, to exercise deadlines. */
  delayMs?: number;
  /** The model id to report as served; defaults to the pinned id. Set differently to simulate a silent swap. */
  servedModelId?: string;
  /** Throw ModelUnavailableError on the first N attempts, then succeed (to exercise retries). */
  failFirst?: number;
  /** Throw ModelUnavailableError on every attempt (to exercise the circuit breaker and abstention). */
  alwaysFail?: boolean;
};

/**
 * A deterministic, offline ModelAdapter for tests and shadow diagnostics. It never touches the network, so
 * the whole analyst pipeline - validation, abstention, retries, breaker, budgets - can be exercised with no
 * provider and no credentials, the same way the synthetic broker adapter exercises the order path.
 */
export class DeterministicStubAdapter implements ModelAdapter {
  readonly modelId: string;
  private readonly behavior: StubBehavior;
  private attempts = 0;

  constructor(modelId: string, behavior: StubBehavior = {}) {
    this.modelId = modelId;
    this.behavior = behavior;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.attempts += 1;
    const b = this.behavior;
    if (b.delayMs !== undefined && b.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, b.delayMs));
    }
    if (b.alwaysFail || (b.failFirst !== undefined && this.attempts <= b.failFirst)) {
      throw new ModelUnavailableError(`stub failure on attempt ${this.attempts}`);
    }
    const raw = b.respond ? b.respond(request) : b.raw;
    return {
      raw,
      usage: { ...ZERO_USAGE, ...b.usage },
      latencyMs: b.latencyMs ?? 0,
      servedModelId: b.servedModelId ?? this.modelId,
    };
  }
}
