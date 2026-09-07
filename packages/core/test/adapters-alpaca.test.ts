import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, sha256Hex, utc } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { ArtifactStore } from "../src/data/artifacts/store.ts";
import { AllowlistedHttpClient, type FetchLike } from "../src/data/http.ts";
import { openCoreDb } from "../src/db/open.ts";
import { MissingSourceCredentialError } from "../src/errors.ts";
import { ALPACA_BARS_SOURCE_ID, barsRequestUrl, fetchDailyBars, parseBars, parseBarsPage } from "../src/data/adapters/alpaca-bars.ts";

const FIXTURES = new URL("../../../test/fixtures/alpaca/", import.meta.url);
const page1 = new Uint8Array(readFileSync(new URL("bars-1d-page1.json", FIXTURES)));
const page2 = new Uint8Array(readFileSync(new URL("bars-1d-page2.json", FIXTURES)));
const stale = new Uint8Array(readFileSync(new URL("bars-1d-stale.json", FIXTURES)));
const calendar = new NyseCalendar();
const ingestedAt = utc("2026-12-01T00:00:00Z");
const ctxFor = (b: Uint8Array) => ({ calendar, ingestedAt, rawContentHash: `sha256:${sha256Hex(b)}` });
const toBuf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const KEY_ID = "fake-alpaca-key-id-0001";
const SECRET = "fake-alpaca-secret-key-0001";

describe("Alpaca IEX daily bars parser", () => {
  const rows = parseBars(page1, ctxFor(page1));
  const bySession = (s: string) => {
    const r = rows.find((x) => x.value.session === s);
    if (!r) throw new Error(`missing ${s}`);
    return r;
  };

  it("uses the calendar close for observedAt and close + 60 min (estimated) for availableAt", () => {
    expect(rows).toHaveLength(3);
    const edt = bySession("2026-09-15");
    expect(edt.observedAt).toBe("2026-09-15T20:00:00.000Z");
    expect(edt.availableAt).toBe("2026-09-15T21:00:00.000Z");
    const est = bySession("2026-11-25");
    expect(est.observedAt).toBe("2026-11-25T21:00:00.000Z");
    expect(est.availableAt).toBe("2026-11-25T22:00:00.000Z");
    for (const r of rows) expect(r.qualityFlags).toEqual(["AVAILABLE_AT_ESTIMATED"]);
  });

  it("honours the 13:00 ET early close on the day after Thanksgiving", () => {
    const early = bySession("2026-11-27");
    expect(early.observedAt).toBe("2026-11-27T18:00:00.000Z");
    expect(early.availableAt).toBe("2026-11-27T19:00:00.000Z");
    expect(early.sourceLocator).toBe("alpaca/bars/1d/SPY/2026-11-27");
  });

  it("stores prices and volume as decimal strings labelled iex, never as floats", () => {
    const r = bySession("2026-09-15");
    expect(r.sourceId).toBe(ALPACA_BARS_SOURCE_ID);
    expect(r.entityId).toBe("SPY");
    expect(r.value).toEqual({
      symbol: "SPY",
      session: "2026-09-15",
      open: "651.12",
      high: "655.4",
      low: "649.9",
      close: "654.31",
      volume: "41234567",
      tradeCount: 312456,
      vwap: "652.8841",
      venue: "iex",
      providerTimestamp: "2026-09-15T04:00:00.000Z",
    });
    const paged = parseBarsPage(page1, ctxFor(page1));
    expect(paged.nextPageToken).toBe("U1BZfDIwMjYtMTEtMjdUMDU6MDA6MDBa");
    const second = parseBarsPage(page2, ctxFor(page2));
    expect(second.nextPageToken).toBeNull();
    expect(second.observations.map((o) => o.value.symbol)).toEqual(["VTI", "VTI"]);
    expect(second.observations[1]?.value.vwap).toBeNull();
  });

  it("maps symbols to stable entity ids when a mapping is supplied", () => {
    const mapped = parseBars(page1, { ...ctxFor(page1), entityIds: { SPY: "etf:spdr-sp500" } });
    expect(mapped.every((o) => o.entityId === "etf:spdr-sp500")).toBe(true);
  });

  it("flags a repeated session and a non-session bar as STALE_BAR", () => {
    const s = parseBars(stale, ctxFor(stale));
    expect(s).toHaveLength(3);
    expect(s[0]?.qualityFlags).toEqual(["AVAILABLE_AT_ESTIMATED"]);
    expect(s[1]?.qualityFlags).toEqual(["AVAILABLE_AT_ESTIMATED", "STALE_BAR"]);
    expect(s[1]?.sourceLocator).toBe("alpaca/bars/1d/SPY/2026-11-27#repeat1");
    const saturday = s[2];
    expect(saturday?.value.session).toBe("2026-11-28");
    expect(saturday?.qualityFlags).toEqual(["AVAILABLE_AT_ESTIMATED", "STALE_BAR"]);
    expect(saturday?.observedAt).toBe("2026-11-28T05:00:00.000Z");
    expect(saturday?.availableAt).toBe("2026-11-30T22:00:00.000Z"); // next session close + 60 min
  });

  it("is deterministic", () => {
    expect(JSON.stringify(parseBars(page1, ctxFor(page1)))).toBe(JSON.stringify(rows));
  });
});

describe("Alpaca IEX daily bars fetcher", () => {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  let status = 200;
  const fakeFetch: FetchLike = (url, init) => {
    requests.push({ url, headers: init.headers });
    const body = new URL(url).searchParams.has("page_token") ? page2 : page1;
    return Promise.resolve({ status, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(toBuf(body)) });
  };
  const client = new AllowlistedHttpClient({ allowlist: ["data.alpaca.markets"], userAgent: "BlackGold/0.1.0 (ops@example.invalid)", fetchImpl: fakeFetch, sleep: () => Promise.resolve() });
  const dir = mkdtempSync(join(tmpdir(), "bg-alpaca-"));
  const { db } = openCoreDb({ dbPath: join(dir, "x.sqlite") });
  const store = new ArtifactStore(join(dir, "artifacts"), db);
  const base = { calendar, ingestedAt, symbols: ["spy", "VTI"], start: isoDate("2026-09-01"), end: isoDate("2026-11-30") };

  it("refuses without both keys before any request", async () => {
    requests.length = 0;
    await expect(fetchDailyBars(client, store, { ...base, keyId: KEY_ID })).rejects.toThrow(MissingSourceCredentialError);
    await expect(fetchDailyBars(client, store, { ...base, secretKey: SECRET })).rejects.toThrow(MissingSourceCredentialError);
    expect(requests).toHaveLength(0);
  });

  it("follows next_page_token, stores each page, sends credentials only as headers", async () => {
    requests.length = 0;
    const out = await fetchDailyBars(client, store, { ...base, keyId: KEY_ID, secretKey: SECRET });
    expect(requests).toHaveLength(2);
    const first = new URL(requests[0]?.url ?? "");
    expect(first.origin + first.pathname).toBe("https://data.alpaca.markets/v2/stocks/bars");
    expect(first.searchParams.get("symbols")).toBe("SPY,VTI");
    expect(first.searchParams.get("feed")).toBe("iex");
    expect(first.searchParams.get("adjustment")).toBe("raw");
    expect(first.searchParams.get("timeframe")).toBe("1Day");
    expect(new URL(requests[1]?.url ?? "").searchParams.get("page_token")).toBe("U1BZfDIwMjYtMTEtMjdUMDU6MDA6MDBa");
    for (const r of requests) {
      expect(r.headers["APCA-API-KEY-ID"]).toBe(KEY_ID);
      expect(r.headers["APCA-API-SECRET-KEY"]).toBe(SECRET);
      expect(r.url).not.toContain(KEY_ID);
    }
    expect(out.artifacts).toHaveLength(2);
    expect(out.artifacts.map((a) => a.hash)).toEqual([`sha256:${sha256Hex(page1)}`, `sha256:${sha256Hex(page2)}`]);
    expect(out.observations).toHaveLength(5);
    expect(out.observations.filter((o) => o.rawContentHash === out.artifacts[0]?.hash)).toHaveLength(3);
    expect(out.observations.filter((o) => o.rawContentHash === out.artifacts[1]?.hash)).toHaveLength(2);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(KEY_ID);
    expect(serialized).not.toContain(SECRET);
    expect(barsRequestUrl(base)).not.toContain("page_token");
  });

  it("scrubs credentials from transport errors", async () => {
    status = 403;
    try {
      await expect(fetchDailyBars(client, store, { ...base, keyId: KEY_ID, secretKey: SECRET })).rejects.toSatisfy((e: unknown) => e instanceof Error && e.name === "HttpError" && !e.message.includes(KEY_ID) && !e.message.includes(SECRET));
    } finally {
      status = 200;
    }
  });
});
