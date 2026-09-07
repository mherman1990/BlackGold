import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, utc } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { ArtifactStore } from "../src/data/artifacts/store.ts";
import { AllowlistedHttpClient, type FetchLike } from "../src/data/http.ts";
import { PointInTimeRepository } from "../src/data/pit/repository.ts";
import { openCoreDb } from "../src/db/open.ts";
import { MissingSourceCredentialError } from "../src/errors.ts";
import { fetchSeriesVintages, fetchVintageDates, fredSourceId, parseObservations, type FredObservationValue } from "../src/data/adapters/fred.ts";

const FIXTURES = new URL("../../../test/fixtures/fred/", import.meta.url);
const obsBytes = new Uint8Array(readFileSync(new URL("observations-TESTPCT.json", FIXTURES)));
const vintageBytes = new Uint8Array(readFileSync(new URL("vintagedates-TESTPCT.json", FIXTURES)));
const calendar = new NyseCalendar();
const ingestedAt = utc("2026-09-07T00:00:00Z");
const FAKE_KEY = "fakefredkey0123456789abcdef";
const toBuf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe("FRED/ALFRED observations parser", () => {
  const rows = parseObservations(obsBytes, { calendar, ingestedAt, rawContentHash: `sha256:${sha256Hex(obsBytes)}`, seriesId: "testpct" });

  it("stores one row per vintage of the same period with vintageAt = realtime_start and an estimated 08:30 ET release", () => {
    expect(rows).toHaveLength(4);
    const feb = rows.filter((r) => r.effectiveAt === "2026-02-01T00:00:00.000Z");
    expect(feb.map((r) => r.vintageAt)).toEqual(["2026-03-11T00:00:00.000Z", "2026-04-10T00:00:00.000Z", "2026-05-12T00:00:00.000Z"]);
    expect(feb.map((r) => r.availableAt)).toEqual(["2026-03-11T12:30:00.000Z", "2026-04-10T12:30:00.000Z", "2026-05-12T12:30:00.000Z"]);
    expect(feb.map((r) => r.value.value)).toEqual(["0.2", "0.1", "-0.1"]);
    for (const r of rows) {
      expect(r.sourceId).toBe("fred.TESTPCT");
      expect(r.entityId).toBe("TESTPCT");
      expect(r.qualityFlags).toEqual(["AVAILABLE_AT_ESTIMATED"]);
      expect(r.sourceLocator).toBe("fred/series/observations?series_id=TESTPCT&realtime_start=1776-07-04&realtime_end=9999-12-31");
      expect(r.value.value === null || typeof r.value.value === "string").toBe(true);
      expect(r.value.realtimeEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("maps FRED's '.' to null instead of zero", () => {
    const mar = rows.find((r) => r.effectiveAt === "2026-03-01T00:00:00.000Z");
    expect(mar?.value.value).toBeNull();
  });

  it("through the repository, a decision between vintages sees only the vintage available then", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-fred-"));
    const { db } = openCoreDb({ dbPath: join(dir, "x.sqlite") });
    const repo = new PointInTimeRepository(db);
    repo.appendMany(rows);
    const q = (decisionAt: string) => repo.asOf<FredObservationValue>({ sourceId: fredSourceId("TESTPCT"), decisionAt: utc(decisionAt), effectiveFrom: utc("2026-02-01T00:00:00Z"), effectiveTo: utc("2026-02-01T00:00:00Z") });
    expect(q("2026-03-11T13:00:00Z").rows).toHaveLength(0); // 12:30Z release + 60 min macro delay not yet elapsed
    expect(q("2026-03-11T13:30:00Z").rows.map((r) => r.value.value)).toEqual(["0.2"]);
    expect(q("2026-04-15T00:00:00Z").rows.map((r) => r.value.value)).toEqual(["0.1"]);
    expect(q("2026-06-01T00:00:00Z").rows.map((r) => r.value.value)).toEqual(["-0.1"]);
    db.close();
  });
});

describe("FRED fetchers", () => {
  const requested: string[] = [];
  let status = 200;
  const fakeFetch: FetchLike = (url) => {
    requested.push(url);
    const body = url.includes("/vintagedates") ? vintageBytes : obsBytes;
    return Promise.resolve({ status, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(toBuf(body)) });
  };
  const client = new AllowlistedHttpClient({ allowlist: ["api.stlouisfed.org"], userAgent: "BlackGold/0.1.0 (ops@example.invalid)", fetchImpl: fakeFetch, sleep: () => Promise.resolve() });
  const dir = mkdtempSync(join(tmpdir(), "bg-fredfetch-"));
  const { db } = openCoreDb({ dbPath: join(dir, "x.sqlite") });
  const store = new ArtifactStore(join(dir, "artifacts"), db);

  it("refuses without an API key before any request", async () => {
    requested.length = 0;
    await expect(fetchSeriesVintages(client, store, "TESTPCT", { calendar, ingestedAt })).rejects.toThrow(MissingSourceCredentialError);
    await expect(fetchVintageDates(client, store, "TESTPCT", { calendar, ingestedAt })).rejects.toThrow(MissingSourceCredentialError);
    expect(requested).toHaveLength(0);
  });

  it("sends the key only in the request URL and strips it from locators, values, and artifact metadata", async () => {
    const out = await fetchSeriesVintages(client, store, "TESTPCT", { calendar, ingestedAt, apiKey: FAKE_KEY });
    const req = new URL(requested[0] ?? "");
    expect(req.origin + req.pathname).toBe("https://api.stlouisfed.org/fred/series/observations");
    expect(req.searchParams.get("api_key")).toBe(FAKE_KEY);
    expect(req.searchParams.get("realtime_start")).toBe("1776-07-04");
    expect(req.searchParams.get("realtime_end")).toBe("9999-12-31");
    expect(out.artifacts[0]?.locator).toBe("fred/series/observations?series_id=TESTPCT&realtime_start=1776-07-04&realtime_end=9999-12-31");
    expect(store.meta(out.artifacts[0]?.hash ?? "")?.firstLocator).not.toContain(FAKE_KEY);
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(out.observations).toHaveLength(4);
    expect(out.observations.every((o) => o.rawContentHash === `sha256:${sha256Hex(obsBytes)}`)).toBe(true);
  });

  it("enumerates vintage dates", async () => {
    const out = await fetchVintageDates(client, store, "TESTPCT", { calendar, ingestedAt, apiKey: FAKE_KEY });
    expect(out.vintageDates).toEqual(["2026-03-11", "2026-04-10", "2026-05-12"]);
    expect(out.artifacts[0]?.locator).toBe("fred/series/vintagedates?series_id=TESTPCT");
  });

  it("scrubs the key from transport error messages", async () => {
    status = 500;
    try {
      await expect(fetchSeriesVintages(client, store, "TESTPCT", { calendar, ingestedAt, apiKey: FAKE_KEY })).rejects.toSatisfy((e: unknown) => e instanceof Error && e.name === "HttpError" && !e.message.includes(FAKE_KEY) && e.message.includes("[REDACTED]"));
    } finally {
      status = 200;
    }
  });
});
