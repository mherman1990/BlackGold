import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { constants as zc, zstdCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@blackgold/shared";
import { AllowlistedHttpClient, ArtifactBudgetExceededError, ArtifactIntegrityError, ArtifactStore, EgressDeniedError, HttpError, openCoreDb, type FetchLike } from "../src/index.ts";

function store(): ArtifactStore {
  const dir = mkdtempSync(join(tmpdir(), "bg-art-"));
  return new ArtifactStore(join(dir, "artifacts"), openCoreDb({ dbPath: join(dir, "a.sqlite") }).db);
}

describe("ArtifactStore", () => {
  it("is content-addressed, deduplicates, round-trips, and verifies", () => {
    const s = store();
    const bytes = Buffer.from(JSON.stringify({ hello: "world", pad: "x".repeat(2000) }));
    const a = s.put(bytes, { locator: "https://example.invalid/a", mime: "application/json", retention: "macro" });
    expect(a.hash).toBe(`sha256:${sha256Hex(bytes)}`);
    expect(a.bytesCompressed).toBeLessThan(a.bytesRaw);
    const b = s.put(bytes, { locator: "https://example.invalid/again" });
    expect(b.deduplicated).toBe(true);
    expect(s.count()).toBe(1);
    expect(Buffer.from(s.get(a.hash)).equals(bytes)).toBe(true);
    expect(s.verify(a.hash)).toEqual({ hash: a.hash, ok: true });
    expect(s.meta(a.hash)?.firstLocator).toBe("https://example.invalid/a");
  });

  it("detects a byte flip on disk and a missing file", () => {
    const s = store();
    const { hash } = s.put(Buffer.from("immutable by convention, tamper-evident by design"), { locator: "x" });
    const path = s.meta(hash)?.path ?? "";
    const buf = readFileSync(path);
    buf[buf.length - 1] = buf[buf.length - 1] === 0 ? 1 : 0; // corrupt the zstd frame tail
    writeFileSync(path, buf);
    const v = s.verify(hash);
    expect(v.ok).toBe(false);
    expect(["hash_mismatch", "decompress_failed"]).toContain(v.reason);
    expect(() => s.get(hash)).toThrow(ArtifactIntegrityError);
    expect(s.verify("sha256:" + "0".repeat(64))).toMatchObject({ ok: false, reason: "missing" });
  });

  it("refuses, before writing, any put that would carry the store past its byte budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-art-"));
    const db = openCoreDb({ dbPath: join(dir, "a.sqlite") }).db;
    const first = Buffer.from(JSON.stringify({ page: 1, pad: "a".repeat(3000) }));
    const second = Buffer.from(JSON.stringify({ page: 2, pad: "b".repeat(3000) }));
    const firstCompressed = zstdCompressSync(first, { params: { [zc.ZSTD_c_compressionLevel]: 9 } }).byteLength;
    const s = new ArtifactStore(join(dir, "capped"), db, Date.now, { budgetBytes: firstCompressed + 1 });
    expect(s.put(first, { locator: "p/1" })).toMatchObject({ deduplicated: false, bytesCompressed: firstCompressed });
    expect(s.usageBytes()).toBe(firstCompressed);
    let caught: unknown;
    try {
      s.put(second, { locator: "p/2" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArtifactBudgetExceededError);
    const e = caught as ArtifactBudgetExceededError;
    expect(e.usageBytes).toBe(firstCompressed);
    expect(e.budgetBytes).toBe(firstCompressed + 1);
    expect(e.attemptedBytes).toBeGreaterThan(0);
    expect(s.has(`sha256:${sha256Hex(second)}`)).toBe(false); // nothing written, no metadata row
    expect(s.meta(`sha256:${sha256Hex(second)}`)).toBeUndefined();
    expect(s.usageBytes()).toBe(firstCompressed);
    expect(s.diskUsageBytes()).toBe(firstCompressed);
    expect(s.count()).toBe(1);
    // Re-putting existing content is a metadata touch, never a write, so it is always within budget.
    expect(s.put(first, { locator: "p/1-again" }).deduplicated).toBe(true);
    expect(() => new ArtifactStore(join(dir, "x"), db, Date.now, { budgetBytes: 0 })).toThrow(RangeError);
  });

  it("verifySample walks the store deterministically", () => {
    const s = store();
    for (let i = 0; i < 5; i++) s.put(Buffer.from(`artifact ${i}`), { locator: `l${i}` });
    expect(s.verifySample(3).every((r) => r.ok)).toBe(true);
    expect(s.verifySample(10)).toHaveLength(5);
    expect(s.diskUsageBytes()).toBeGreaterThan(0);
  });
});

describe("AllowlistedHttpClient", () => {
  const calls: string[] = [];
  const fakeFetch: FetchLike = (url) => {
    calls.push(url);
    const status = url.endsWith("/missing") ? 404 : url.endsWith("/cached") ? 304 : 200;
    return Promise.resolve({
      status,
      headers: { get: (n: string) => (n === "etag" ? '"abc"' : n === "content-type" ? "application/json" : null) },
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(`{"url":"${url}"}`).buffer),
    });
  };
  const client = (): AllowlistedHttpClient =>
    new AllowlistedHttpClient({
      allowlist: ["data.sec.gov"],
      userAgent: "BlackGold/0.1.0 (test@example.invalid)",
      ratePerSecond: { "data.sec.gov": 2 },
      fetchImpl: fakeFetch,
      clock: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
      sleep: () => Promise.resolve(),
    });

  it("refuses hosts outside the allowlist and non-https before any network call", async () => {
    const c = client();
    calls.length = 0;
    await expect(c.get("https://broker.example.invalid/v2/orders")).rejects.toThrow(EgressDeniedError);
    await expect(c.get("https://evil.data.sec.gov/x")).rejects.toThrow(EgressDeniedError);
    await expect(c.get("http://data.sec.gov/x")).rejects.toThrow(EgressDeniedError);
    expect(calls).toHaveLength(0);
  });

  it("fetches allowlisted hosts with the declared user agent, handles 304 and errors", async () => {
    const c = client();
    const res = await c.get("https://data.sec.gov/submissions/CIK0000320193.json");
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toContain("CIK0000320193");
    expect(res.etag).toBe('"abc"');
    const cached = await c.get("https://data.sec.gov/cached", { ifNoneMatch: '"abc"' });
    expect(cached.notModified).toBe(true);
    await expect(c.get("https://data.sec.gov/missing")).rejects.toThrow(HttpError);
    expect(c.requests()).toBe(3);
  });

  it("rate limits per host with a token bucket", async () => {
    let waited = 0;
    const c = new AllowlistedHttpClient({
      allowlist: ["data.sec.gov"],
      userAgent: "BlackGold/0.1.0 (test@example.invalid)",
      ratePerSecond: { "data.sec.gov": 2 },
      fetchImpl: fakeFetch,
      clock: () => 1_000_000, // frozen clock: no refill, so the third request must wait
      sleep: (ms) => {
        waited += ms;
        // advance nothing; the test only checks that a wait was requested once tokens ran out
        return Promise.reject(new Error(`would sleep ${ms}`));
      },
    });
    await c.get("https://data.sec.gov/a");
    await c.get("https://data.sec.gov/b");
    await expect(c.get("https://data.sec.gov/c")).rejects.toThrow(/would sleep/);
    expect(waited).toBeGreaterThan(0);
  });

  it("rejects an empty allowlist or an anonymous user agent", () => {
    expect(() => new AllowlistedHttpClient({ allowlist: [], userAgent: "BlackGold/0.1.0 (x@y.z)" })).toThrow(RangeError);
    expect(() => new AllowlistedHttpClient({ allowlist: ["data.sec.gov"], userAgent: "bot" })).toThrow(RangeError);
  });
});
