import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, sha256Hex, utc, type IsoDate } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { ArtifactStore } from "../src/data/artifacts/store.ts";
import { AllowlistedHttpClient, type FetchLike } from "../src/data/http.ts";
import { PointInTimeRepository } from "../src/data/pit/repository.ts";
import { openCoreDb } from "../src/db/open.ts";
import { MissingSourceCredentialError } from "../src/errors.ts";
import { fetchSeriesVintages, fetchVintageDates, fredSourceId, parseObservations, vintageWindows, type FredObservationValue } from "../src/data/adapters/fred.ts";

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
    requested.length = 0;
    const out = await fetchSeriesVintages(client, store, "TESTPCT", { calendar, ingestedAt, apiKey: FAKE_KEY });

    // Vintage dates are fetched first now: window boundaries have to be real vintage dates, so the listing
    // has to come before any observations request (CR-28).
    expect(new URL(requested[0] ?? "").pathname).toBe("/fred/series/vintagedates");
    expect(requested.some((u) => new URL(u).pathname === "/fred/series/observations")).toBe(true);

    // The property under test, asserted across every request and every artifact rather than just the first:
    // the key travels only in the URL, and reaches no locator, no stored metadata, and no returned value.
    for (const u of requested) {
      const req = new URL(u);
      expect(req.searchParams.get("api_key")).toBe(FAKE_KEY);
      if (req.pathname.endsWith("/vintagedates")) {
        // The listing spans the whole of ALFRED, because the caller narrowed nothing.
        expect(req.searchParams.get("realtime_start")).toBe("1776-07-04");
        expect(req.searchParams.get("realtime_end")).toBe("9999-12-31");
      } else {
        // Observations are requested per window, so the sentinel range must NOT appear here - sending it is
        // exactly the request FRED refuses once a series has more than 2000 vintages.
        expect(req.searchParams.get("realtime_start")).toBe("2026-03-11");
        expect(req.searchParams.get("realtime_end")).toBe("2026-05-12");
      }
    }
    for (const a of out.artifacts) {
      expect(a.locator).not.toContain(FAKE_KEY);
      expect(store.meta(a.hash)?.firstLocator).not.toContain(FAKE_KEY);
    }
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);

    // Three fixture vintages fit one window, so one observations request and its four rows.
    expect(out.artifacts.map((a) => a.locator)).toEqual([
      "fred/series/vintagedates?series_id=TESTPCT&realtime_start=1776-07-04&realtime_end=9999-12-31",
      "fred/series/observations?series_id=TESTPCT&realtime_start=2026-03-11&realtime_end=2026-05-12",
    ]);
    expect(out.observations).toHaveLength(4);
    expect(out.observations.every((o) => o.rawContentHash === `sha256:${sha256Hex(obsBytes)}`)).toBe(true);
  });

  it("enumerates vintage dates", async () => {
    const out = await fetchVintageDates(client, store, "TESTPCT", { calendar, ingestedAt, apiKey: FAKE_KEY });
    expect(out.vintageDates).toEqual(["2026-03-11", "2026-04-10", "2026-05-12"]);
    expect(out.artifacts[0]?.locator).toBe("fred/series/vintagedates?series_id=TESTPCT&realtime_start=1776-07-04&realtime_end=9999-12-31");
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

// FRED refuses a `series/observations` request covering more than 2000 vintage dates, so a long-history
// daily series cannot be fetched in one call at all. Found by the first live ingest, not by these fixtures:
// DGS10 has 5103 vintages and the previous single-request implementation got HTTP 400 every time (CR-28).
describe("vintage windowing", () => {
  const d = (s: string): IsoDate => isoDate(s);

  it("returns no window for an empty vintage list, so the caller can fall back to one request", () => {
    // A series ALFRED does not track has no vintage dates but does have current observations.
    expect(vintageWindows([])).toEqual([]);
  });

  it("returns a single degenerate window for one vintage", () => {
    expect(vintageWindows([d("2020-01-01")])).toEqual([{ start: d("2020-01-01"), end: d("2020-01-01"), sharesPreviousBoundary: false }]);
  });

  it("keeps everything in one window when the list fits the cap", () => {
    const dates = [d("2020-01-01"), d("2020-02-01"), d("2020-03-01")];
    expect(vintageWindows(dates, 2000)).toEqual([{ start: d("2020-01-01"), end: d("2020-03-01"), sharesPreviousBoundary: false }]);
  });

  it("shares each boundary date between adjacent windows", () => {
    // Sharing is what preserves true vintage starts. FRED clips a row's realtime_start to the requested
    // window (CR-29), so a boundary that belonged to only one window would leave the vintages straddling it
    // visible only in clipped form - a fabricated, later-than-true vintage date.
    const dates = [d("2020-01-01"), d("2020-02-01"), d("2020-03-01"), d("2020-04-01"), d("2020-05-01")];
    expect(vintageWindows(dates, 3)).toEqual([
      { start: d("2020-01-01"), end: d("2020-03-01"), sharesPreviousBoundary: false },
      { start: d("2020-03-01"), end: d("2020-05-01"), sharesPreviousBoundary: true },
    ]);
  });

  it("covers every vintage, and only the first window claims no shared boundary", () => {
    const dates = Array.from({ length: 5103 }, (_, i) => d(new Date(Date.UTC(2005, 5, 28 + i)).toISOString().slice(0, 10)));
    const windows = vintageWindows(dates, 2000);
    expect(windows).toHaveLength(3);
    expect(windows[0]?.sharesPreviousBoundary).toBe(false);
    expect(windows.slice(1).every((w) => w.sharesPreviousBoundary)).toBe(true);
    // First and last vintage must be reachable, or vintages are silently dropped.
    expect(windows[0]?.start).toBe(dates[0]);
    expect(windows[windows.length - 1]?.end).toBe(dates[dates.length - 1]);
  });

  it("never emits a window wider than the cap in vintage count", () => {
    // Unique ascending dates, which is what FRED returns. Duplicates would make the count meaningless.
    const dates = Array.from({ length: 97 }, (_, i) => d(new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10)));
    expect(new Set(dates).size).toBe(dates.length);
    for (const max of [2, 3, 10, 96, 97, 98]) {
      for (const w of vintageWindows(dates, max)) {
        const inWindow = dates.filter((x) => x >= w.start && x <= w.end);
        expect(inWindow.length, `max=${max}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("refuses a cap too small to share a boundary", () => {
    // A window of one date could never overlap its neighbour, so clipping would be undetectable.
    expect(() => vintageWindows([d("2020-01-01"), d("2020-02-01")], 1)).toThrow(RangeError);
  });
});
