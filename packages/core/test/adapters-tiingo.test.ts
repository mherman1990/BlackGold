import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, utc } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { parseAppConfig } from "../src/config/load.ts";
import { ArtifactStore } from "../src/data/artifacts/store.ts";
import { AllowlistedHttpClient, PUBLIC_SOURCE_HOSTS, PUBLIC_SOURCE_RATES, type FetchLike } from "../src/data/http.ts";
import { openCoreDb } from "../src/db/open.ts";
import { MissingSourceCredentialError } from "../src/errors.ts";
import { rawBarFromValue } from "../src/market/types.ts";
import { TIINGO_BARS_SOURCE_ID, fetchTiingoDaily, parseTiingoDaily, tiingoRequestUrl } from "../src/data/adapters/tiingo.ts";

const FIX = new URL("../../../test/fixtures/tiingo/", import.meta.url);
const pricesVti = new Uint8Array(readFileSync(new URL("prices-vti.json", FIX)));
const calendar = new NyseCalendar();
const ingestedAt = utc("2026-12-01T00:00:00Z");
const ctxFor = (b: Uint8Array, symbol = "VTI") => ({ calendar, ingestedAt, rawContentHash: `sha256:${sha256Hex(b)}`, symbol });
const toBuf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const KEY = "fake-tiingo-key-0123456789";

describe("Tiingo EOD daily bars parser", () => {
  const rows = parseTiingoDaily(pricesVti, ctxFor(pricesVti));
  const bySession = (s: string) => {
    const r = rows.find((x) => x.value.session === s);
    if (!r) throw new Error(`missing ${s}`);
    return r;
  };

  it("takes the session date directly and uses the calendar close + 60 min (estimated) for availableAt", () => {
    expect(rows).toHaveLength(2);
    const r = bySession("2026-09-15");
    expect(r.sourceId).toBe(TIINGO_BARS_SOURCE_ID);
    expect(r.entityId).toBe("VTI");
    expect(r.observedAt).toBe("2026-09-15T20:00:00.000Z"); // 16:00 ET close
    expect(r.availableAt).toBe("2026-09-15T21:00:00.000Z"); // close + 60 min
    expect(r.qualityFlags).toEqual(["AVAILABLE_AT_ESTIMATED"]);
    expect(r.sourceLocator).toBe("tiingo/eod/1d/VTI/2026-09-15");
    expect(r.value.providerTimestamp).toBe("2026-09-15T00:00:00.000Z");
  });

  it("stores the RAW OHLCV as decimal strings labelled tiingo, and ignores adjusted/dividend/split columns", () => {
    const r = bySession("2026-09-16");
    expect(r.value).toEqual({
      symbol: "VTI",
      session: "2026-09-16",
      open: "301.3",
      high: "303",
      low: "300.9",
      close: "302.8", // the RAW close, not adjClose 301.95
      volume: "2345678",
      venue: "tiingo",
      providerTimestamp: "2026-09-16T00:00:00.000Z",
    });
    // The value round-trips through the shared raw-bar reader the market series uses.
    const bar = rawBarFromValue(r.value);
    expect(bar.close.toFixed()).toBe("302.8");
    expect(bar.venue).toBe("tiingo");
  });
});

describe("Tiingo fetch", () => {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    requests.push({ url, headers: init.headers });
    const u = new URL(url);
    const body = u.hostname === "api.tiingo.com" ? pricesVti : new Uint8Array();
    return Promise.resolve({ status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(toBuf(body)) });
  };

  it("sends the token in a header (never the URL), scrubs it from stored data, and appends readable bars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-tiingo-"));
    const config = parseAppConfig({ dataDir: dir, sources: { tiingoApiKey: KEY } });
    const { db } = openCoreDb(config);
    const client = new AllowlistedHttpClient({ allowlist: PUBLIC_SOURCE_HOSTS, ratePerSecond: PUBLIC_SOURCE_RATES, userAgent: "BlackGold/0.1.0 (ops@example.invalid)", fetchImpl });
    const store = new ArtifactStore(config.artifactsDir, db);

    const outcome = await fetchTiingoDaily(client, store, { calendar, ingestedAt, apiKey: KEY, symbols: ["VTI"], start: "2006-04-01" as never, end: "2026-09-16" as never });
    expect(outcome.observations).toHaveLength(2);
    expect(outcome.artifacts).toHaveLength(1);

    // Token travels only in the Authorization header.
    expect(requests[0]?.headers["Authorization"]).toBe(`Token ${KEY}`);
    expect(requests[0]?.url).not.toContain(KEY);
    expect(requests[0]?.url).toContain("startDate=2006-04-01");
    expect(requests[0]?.url).toContain("format=json");
    // Nothing stored carries the token.
    const stored = [
      ...(db.prepare("SELECT source_locator, value_json FROM observations").all() as Record<string, string>[]).map((r) => Object.values(r).join("\n")),
      ...(db.prepare("SELECT first_locator, path FROM artifacts").all() as Record<string, string>[]).map((r) => Object.values(r).join("\n")),
    ].join("\n");
    expect(stored).not.toContain(KEY);
    db.close();
  });

  it("refuses to fetch without the Tiingo key before any request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-tiingo-"));
    const config = parseAppConfig({ dataDir: dir });
    const { db } = openCoreDb(config);
    const client = new AllowlistedHttpClient({ allowlist: PUBLIC_SOURCE_HOSTS, ratePerSecond: PUBLIC_SOURCE_RATES, userAgent: "BlackGold/0.1.0 (ops@example.invalid)", fetchImpl });
    const store = new ArtifactStore(config.artifactsDir, db);
    await expect(fetchTiingoDaily(client, store, { calendar, ingestedAt, symbols: ["VTI"], start: "2006-04-01" as never, end: "2026-09-16" as never })).rejects.toThrow(MissingSourceCredentialError);
    db.close();
  });
});

describe("Tiingo CLI request url", () => {
  it("builds the per-ticker prices endpoint with the date range", () => {
    const url = tiingoRequestUrl("VTI", "2006-04-01" as never, "2026-09-16" as never);
    expect(url).toBe("https://api.tiingo.com/tiingo/daily/vti/prices?startDate=2006-04-01&endDate=2026-09-16&resampleFreq=daily&format=json");
  });
});
