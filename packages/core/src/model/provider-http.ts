/**
 * The single model-provider egress path (docs/THREAT_MODEL.md F2; docs/PRODUCT_SPEC.md section 6).
 *
 * This is the ONLY module in the codebase that issues an outbound POST to a model provider, and the only one
 * that names `api.anthropic.com`. Data-source reads still go through `data/http.ts` (allowlisted, GET-only);
 * this module is the counterpart for the one thing that layer cannot do - a POST to the inference API. A
 * policy test asserts that no other module references the provider host and that the broker/trading hosts stay
 * forbidden everywhere. No provider SDK is used or added: a thin `fetch` keeps the dependency surface of a
 * financial-critical system minimal and the egress auditable.
 *
 * The transport is injectable so the adapter's request/response mapping is fully testable with no network and
 * no credential; {@link fetchTransport} is the real implementation, exercised only when a key is provisioned.
 */

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** The Messages API version header. An API-version string, not a model id (model ids live in config). */
export const ANTHROPIC_VERSION = "2023-06-01";

export type ProviderHttpRequest = {
  url: string;
  headers: Record<string, string>;
  /** Serialized JSON request body. */
  body: string;
  /** Wall-clock ceiling in milliseconds; the transport aborts past it. */
  deadlineMs: number;
};

export type ProviderHttpResponse = {
  status: number;
  body: string;
};

export type ProviderTransport = (request: ProviderHttpRequest) => Promise<ProviderHttpResponse>;

/**
 * The real transport: a single `fetch` POST with a hard deadline via AbortController. A network failure or a
 * timeout throws, which the adapter maps to a fail-closed abstention. This function is never exercised in unit
 * tests (no network, no key); it is verified once against the live API when a key is provisioned on the Pi.
 */
export function fetchTransport(): ProviderTransport {
  return async (request: ProviderHttpRequest): Promise<ProviderHttpResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.deadlineMs);
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      const body = await response.text();
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
}
