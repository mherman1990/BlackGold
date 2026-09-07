import type { ModelAdapter, ModelRequest, ModelResponse, ModelUsage } from "./adapter.ts";
import { ModelUnavailableError } from "./adapter.ts";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  fetchTransport,
  type ProviderTransport,
} from "./provider-http.ts";

/**
 * The one Anthropic implementation of {@link ModelAdapter} (D-11; docs/PRODUCT_SPEC.md section 6). It is the
 * sole provider-facing module: it builds the Messages API request, POSTs it through the injected transport,
 * and maps the response back to the provider-agnostic {@link ModelResponse}. The API key is passed in from a
 * wiring layer that reads the environment - this module reads no environment variable itself, keeping the
 * model layer env-free (the no-LLM-in-sizing CI gate).
 *
 * Fail-closed by construction: any provider failure - network error, timeout, 4xx/5xx, a refusal, or a
 * non-JSON body - throws {@link ModelUnavailableError}, which the orchestration turns into a safe abstention;
 * a body that parses but does not match the schema is returned as-is for local validation to reject. Nothing
 * here can size a position or form an order; it only returns a candidate `ResearchAssessment` for the
 * deterministic validator to accept or reject.
 *
 * The exact live request/response shape is verified once against the API when a key is provisioned (the
 * deferred CR-12/CR-13 check); unit tests cover request shaping and response mapping against a mock transport.
 */

/** JSON Schema keywords the Messages API structured-output format does not accept; stripped before sending. */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "minItems",
  "maxItems",
]);

/**
 * Deep-strip the constraints structured outputs rejects, leaving shape, `required`, `additionalProperties`,
 * enums and `$ref`. The local {@link import("../research/assessment.ts").validateAssessment} remains the real
 * gate, so a looser provider schema never weakens validation - it only shapes the model's output.
 */
export function sanitizeProviderSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeProviderSchema);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
      out[key] = sanitizeProviderSchema(value);
    }
    return out;
  }
  return node;
}

export type AnthropicAdapterOptions = {
  transport?: ProviderTransport;
  /** Per-response output ceiling. An assessment is a small JSON object; 4096 is ample and cheaper than more. */
  maxOutputTokens?: number;
};

type TextBlock = { type: string; text?: unknown };
type ProviderBody = {
  model?: unknown;
  stop_reason?: unknown;
  content?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown };
};

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class AnthropicAdapter implements ModelAdapter {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly transport: ProviderTransport;
  private readonly maxOutputTokens: number;

  constructor(modelId: string, apiKey: string, options: AnthropicAdapterOptions = {}) {
    this.modelId = modelId;
    this.apiKey = apiKey;
    this.transport = options.transport ?? fetchTransport();
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const body = JSON.stringify({
      model: this.modelId,
      max_tokens: this.maxOutputTokens,
      // The instruction is the stable, cacheable system prompt; the untrusted packet is the user content.
      system: [{ type: "text", text: request.promptText, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: request.packetJson }],
      output_config: { format: { type: "json_schema", schema: sanitizeProviderSchema(request.outputSchema) } },
    });

    const started = Date.now();
    let response;
    try {
      response = await this.transport({
        url: ANTHROPIC_MESSAGES_URL,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
        deadlineMs: request.deadlineMs,
      });
    } catch (error) {
      // AbortError (deadline) or a network failure - retryable, and ends in an abstention.
      throw new ModelUnavailableError(`transport error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const latencyMs = Date.now() - started;

    if (response.status !== 200) {
      // Every non-200 fails closed. 429/5xx are transient; a 4xx (bad key, bad request) is not, but the
      // overlay must never crash a decision path, so it abstains too and the breaker/incident surfaces it.
      throw new ModelUnavailableError(`provider returned HTTP ${response.status}`);
    }

    let parsed: ProviderBody;
    try {
      parsed = JSON.parse(response.body) as ProviderBody;
    } catch {
      throw new ModelUnavailableError("provider returned a non-JSON body");
    }

    if (parsed.stop_reason === "refusal") {
      throw new ModelUnavailableError("provider declined the request (refusal)");
    }

    // Extract the structured JSON from the text block. Anything unparseable is returned as-is so the
    // deterministic validator rejects it (INVALID_OUTPUT) rather than being retried.
    let raw: unknown;
    const blocks = Array.isArray(parsed.content) ? (parsed.content as TextBlock[]) : [];
    const textBlock = blocks.find((b) => b.type === "text");
    if (textBlock !== undefined && typeof textBlock.text === "string") {
      try {
        raw = JSON.parse(textBlock.text);
      } catch {
        raw = textBlock.text;
      }
    }

    const usage: ModelUsage = {
      inputTokens: toCount(parsed.usage?.input_tokens),
      outputTokens: toCount(parsed.usage?.output_tokens),
      cacheReadInputTokens: toCount(parsed.usage?.cache_read_input_tokens),
    };

    return {
      raw,
      usage,
      latencyMs,
      // Empty when the provider omits it; the orchestration then abstains on MODEL_ID_MISMATCH (fail-closed).
      servedModelId: typeof parsed.model === "string" ? parsed.model : "",
    };
  }
}
