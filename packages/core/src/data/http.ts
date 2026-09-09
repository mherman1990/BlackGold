/**
 * The single outbound HTTP egress point in Black Gold core. Every adapter fetches through this client.
 *
 * - Host allowlist (docs/DATA_PROVENANCE_SPEC.md section 10). A URL outside the allowlist throws before any
 *   connection is attempted. Trading and model-provider hosts are never on the list.
 * - Per-host token-bucket rate limiting (SEC fair access: 10 requests/second across the whole system).
 * - Transient throttling (429) and unavailability (503) are retried with bounded exponential backoff, honoring
 *   the provider's Retry-After; safe because every request here is an idempotent GET/HEAD.
 * - Declared User-Agent, conditional requests, bounded response size, deadline per request.
 * - GET and HEAD only. There is no method for POST/PUT/DELETE: this client cannot mutate anything remote.
 * - `fetchImpl` is injectable so tests never touch the network.
 */
import type { UtcInstant } from "@blackgold/shared";
import { nowUtc } from "@blackgold/shared";

export type FetchLike = (url: string, init: { method: "GET" | "HEAD"; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type HttpClientOptions = {
  /** Exact hostnames permitted, e.g. "data.sec.gov". Subdomains are not implied. */
  allowlist: readonly string[];
  userAgent: string;
  /** Requests per second per host. Unlisted hosts get `defaultPerSecond`. */
  ratePerSecond?: Readonly<Record<string, number>>;
  defaultPerSecond?: number;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: FetchLike;
  clock?: () => number;
  /** Injected sleeper so rate-limit waits are testable. */
  sleep?: (ms: number) => Promise<void>;
  /** Max retries for a transient throttle/unavailability (HTTP 429/503) before giving up. Default 4. */
  maxRetries?: number;
  /** Base for exponential backoff between retries, in ms. Default 500. */
  retryBaseMs?: number;
  /** Ceiling on any single backoff wait, in ms; also caps an honored Retry-After. Default 30000. */
  maxRetryDelayMs?: number;
  /** Injected [0,1) source for backoff jitter, so retry waits are deterministic in tests. Default Math.random. */
  random?: () => number;
};

/** Statuses safe to retry for the idempotent GET/HEAD requests this client makes: transient throttling and unavailability. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503]);

export type HttpResponse = {
  url: string;
  status: number;
  body: Uint8Array;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  fetchedAt: UtcInstant;
  notModified: boolean;
};

export class EgressDeniedError extends Error {
  constructor(url: string) {
    super(`Egress denied: ${url} is not on the public-source allowlist`);
    this.name = "EgressDeniedError";
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(url: string, status: number) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export class ResponseTooLargeError extends Error {
  constructor(url: string, bytes: number, max: number) {
    super(`Response from ${url} is ${bytes} bytes; limit ${max}`);
    this.name = "ResponseTooLargeError";
  }
}

type Bucket = { tokens: number; lastRefillMs: number; perSecond: number };

export class AllowlistedHttpClient {
  private readonly allow: ReadonlySet<string>;
  private readonly userAgent: string;
  private readonly rates: Readonly<Record<string, number>>;
  private readonly defaultPerSecond: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly random: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private requestCount = 0;

  constructor(opts: HttpClientOptions) {
    if (opts.allowlist.length === 0) throw new RangeError("allowlist must not be empty");
    if (opts.userAgent.trim().length < 8) throw new RangeError("userAgent must identify the application and a contact");
    this.allow = new Set(opts.allowlist.map((h) => h.toLowerCase()));
    this.userAgent = opts.userAgent;
    this.rates = opts.ratePerSecond ?? {};
    this.defaultPerSecond = opts.defaultPerSecond ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 4;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 30_000;
    this.random = opts.random ?? Math.random;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) throw new RangeError("maxRetries must be a non-negative integer");
    if (!(this.retryBaseMs > 0) || !(this.maxRetryDelayMs > 0)) throw new RangeError("retryBaseMs and maxRetryDelayMs must be positive");
  }

  isAllowed(url: string): boolean {
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return false;
      host = u.hostname.toLowerCase();
    } catch {
      return false;
    }
    return this.allow.has(host);
  }

  requests(): number {
    return this.requestCount;
  }

  async get(url: string, opts: { headers?: Record<string, string>; ifNoneMatch?: string; ifModifiedSince?: string } = {}): Promise<HttpResponse> {
    return this.request("GET", url, opts);
  }

  async head(url: string): Promise<HttpResponse> {
    return this.request("HEAD", url, {});
  }

  private async request(
    method: "GET" | "HEAD",
    url: string,
    opts: { headers?: Record<string, string>; ifNoneMatch?: string; ifModifiedSince?: string },
  ): Promise<HttpResponse> {
    if (!this.isAllowed(url)) throw new EgressDeniedError(url);
    const host = new URL(url).hostname.toLowerCase();
    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      accept: "application/json, text/plain, */*",
      "accept-encoding": "gzip, deflate",
      ...(opts.headers ?? {}),
    };
    if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;
    if (opts.ifModifiedSince) headers["if-modified-since"] = opts.ifModifiedSince;
    // A transient 429/503 is retried with bounded backoff (honoring Retry-After) rather than failing the whole
    // ingest; every attempt takes a fresh rate-limit token and its own deadline. Non-transient errors throw at once.
    for (let attempt = 0; ; attempt++) {
      await this.takeToken(host);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, this.timeoutMs);
      try {
        this.requestCount++;
        const res = await this.fetchImpl(url, { method, headers, signal: controller.signal });
        const fetchedAt = nowUtc(this.clock);
        if (res.status === 304) {
          return { url, status: 304, body: new Uint8Array(0), etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified"), contentType: res.headers.get("content-type"), fetchedAt, notModified: true };
        }
        if (RETRYABLE_STATUSES.has(res.status) && attempt < this.maxRetries) {
          const delayMs = this.retryDelayMs(res.headers.get("retry-after"), attempt);
          await res.arrayBuffer().catch(() => undefined); // drain the (small) error body so the connection can be reused
          clearTimeout(timer);
          await this.sleep(delayMs);
          continue;
        }
        if (res.status < 200 || res.status >= 300) throw new HttpError(url, res.status);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > this.maxBytes) throw new ResponseTooLargeError(url, buf.byteLength, this.maxBytes);
        return { url, status: res.status, body: buf, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified"), contentType: res.headers.get("content-type"), fetchedAt, notModified: false };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Backoff before retrying a transient status. Honors a `Retry-After` header (delta-seconds or an HTTP date),
   * capped at `maxRetryDelayMs`; otherwise exponential backoff `retryBaseMs * 2^attempt` with additive jitter in
   * `[0, base)`, also capped. Never negative.
   */
  private retryDelayMs(retryAfter: string | null, attempt: number): number {
    if (retryAfter !== null && retryAfter.trim() !== "") {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.min(Math.max(0, secs) * 1000, this.maxRetryDelayMs);
      const when = Date.parse(retryAfter);
      if (!Number.isNaN(when)) return Math.min(Math.max(0, when - this.clock()), this.maxRetryDelayMs);
    }
    const base = this.retryBaseMs * 2 ** attempt;
    return Math.min(base + this.random() * base, this.maxRetryDelayMs);
  }

  private async takeToken(host: string): Promise<void> {
    const perSecond = this.rates[host] ?? this.defaultPerSecond;
    let b = this.buckets.get(host);
    const now = this.clock();
    if (!b) {
      b = { tokens: perSecond, lastRefillMs: now, perSecond };
      this.buckets.set(host, b);
    }
    for (;;) {
      const t = this.clock();
      const refill = ((t - b.lastRefillMs) / 1000) * b.perSecond;
      b.tokens = Math.min(b.perSecond, b.tokens + refill);
      b.lastRefillMs = t;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - b.tokens) / b.perSecond) * 1000);
      await this.sleep(waitMs);
    }
  }
}

/** Default egress: the platform fetch. Only this file may reference it (policy test). */
const defaultFetch: FetchLike = async (url, init) => {
  const res = await globalThis.fetch(url, { method: init.method, headers: init.headers, signal: init.signal, redirect: "error" });
  return { status: res.status, headers: res.headers, arrayBuffer: () => res.arrayBuffer() };
};

/** Allowlisted public-source hosts (docs/DATA_PROVENANCE_SPEC.md section 10). Adding one requires a PR. */
export const PUBLIC_SOURCE_HOSTS: readonly string[] = [
  "data.sec.gov",
  "www.sec.gov",
  "api.stlouisfed.org",
  "publicreporting.cftc.gov",
  "home.treasury.gov",
  "api.bls.gov",
  "apps.bea.gov",
  "data.alpaca.markets",
  "api.tiingo.com",
];

/** Per-host rate limits. SEC fair-access guidance is 10 requests/second across all Black Gold processes. */
export const PUBLIC_SOURCE_RATES: Readonly<Record<string, number>> = {
  "data.sec.gov": 8,
  "www.sec.gov": 8,
  "api.stlouisfed.org": 2,
  "publicreporting.cftc.gov": 2,
  "data.alpaca.markets": 3,
  "api.tiingo.com": 3,
};
