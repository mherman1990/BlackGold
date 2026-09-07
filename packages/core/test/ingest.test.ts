import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, utc, type Db } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { parseAppConfig, type AppConfig } from "../src/config/load.ts";
import { ArtifactStore } from "../src/data/artifacts/store.ts";
import type { FetchLike } from "../src/data/http.ts";
import { openCoreDb } from "../src/db/open.ts";
import { MissingSourceCredentialError } from "../src/errors.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { ArtifactBudgetExceededError, parseIngestArgs, runIngest, UsageError, type IngestRequest } from "../src/ingest/run.ts";

const FIX = new URL("../../../test/fixtures/", import.meta.url);
const read = (p: string): Uint8Array => new Uint8Array(readFileSync(new URL(p, FIX)));
const fixtures = {
  sec: read("sec/submissions-CIK0000012345.json"),
  fred: read("fred/observations-TESTPCT.json"),
  cot: read("cftc/legacy-futures-three-weeks.json"),
  alpaca1: read("alpaca/bars-1d-page1.json"),
  alpaca2: read("alpaca/bars-1d-page2.json"),
};
const FRED_KEY = "fakefredkey0123456789abcdef";
const ALPACA_ID = "fake-alpaca-key-id-0001";
const ALPACA_SECRET = "fake-alpaca-secret-key-0001";
const CONTACT = "ops@example.invalid";
const toBuf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function harness(overrides: Record<string, unknown> = {}): { db: Db; config: AppConfig; requests: { url: string; headers: Record<string, string> }[]; fetchImpl: FetchLike } {
  const dir = mkdtempSync(join(tmpdir(), "bg-ingest-"));
  const config = parseAppConfig({
    dataDir: dir,
    sources: { secUserAgentContact: CONTACT, fredApiKey: FRED_KEY, alpacaKeyId: ALPACA_ID, alpacaSecretKey: ALPACA_SECRET, ...overrides },
  });
  const { db } = openCoreDb(config);
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    requests.push({ url, headers: init.headers });
    const u = new URL(url);
    let body: Uint8Array;
    if (u.hostname === "data.sec.gov") body = fixtures.sec;
    else if (u.hostname === "api.stlouisfed.org") body = fixtures.fred;
    else if (u.hostname === "publicreporting.cftc.gov") body = fixtures.cot;
    else if (u.hostname === "data.alpaca.markets") body = u.searchParams.has("page_token") ? fixtures.alpaca2 : fixtures.alpaca1;
    else return Promise.resolve({ status: 404, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    return Promise.resolve({ status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(toBuf(body)) });
  };
  return { db, config, requests, fetchImpl };
}

const calendar = new NyseCalendar();
const clock = (): number => Date.parse("2026-12-01T12:00:00Z");
const SEC_REQUEST: IngestRequest = { source: "sec-submissions", cik: "12345" };
const FRED_REQUEST: IngestRequest = { source: "fred", seriesId: "TESTPCT" };
const COT_REQUEST: IngestRequest = { source: "cot", dataset: "legacy_futures", marketCode: "099741", from: isoDate("2026-01-01"), to: isoDate("2026-07-31") };
const ALPACA_REQUEST: IngestRequest = { source: "alpaca-bars", symbols: ["SPY", "VTI"], start: isoDate("2026-09-01"), end: isoDate("2026-11-30") };
const REQUESTS: IngestRequest[] = [SEC_REQUEST, FRED_REQUEST, COT_REQUEST, ALPACA_REQUEST];

function allStoredText(db: Db): string {
  const parts: string[] = [];
  for (const r of db.prepare("SELECT source_locator, value_json, quality_flags_json FROM observations").all() as Record<string, string>[]) parts.push(Object.values(r).join("\n"));
  for (const r of db.prepare("SELECT first_locator, path FROM artifacts").all() as Record<string, string>[]) parts.push(Object.values(r).join("\n"));
  for (const r of db.prepare("SELECT kind, payload FROM ledger_events").all() as Record<string, string>[]) parts.push(Object.values(r).join("\n"));
  return parts.join("\n");
}

describe("ingest run", () => {
  it("stores artifacts, appends linked observations, writes a ledger event, and leaks no credential", async () => {
    const h = harness();
    const deps = { db: h.db, config: h.config, calendar, clock, fetchImpl: h.fetchImpl };
    const reports = [];
    for (const req of REQUESTS) reports.push(await runIngest(deps, req));

    expect(reports.map((r) => [r.source, r.artifacts, r.observations, r.deduplicated, r.conflicts, r.requestCount])).toEqual([
      ["sec-submissions", 1, 8, 0, 0, 1],
      ["fred", 1, 4, 0, 0, 1],
      ["cot", 1, 3, 0, 0, 1],
      ["alpaca-bars", 2, 5, 0, 0, 2],
    ]);
    expect(reports[0]?.sourceIds).toEqual(["sec.edgar.form4", "sec.edgar.submissions"]);
    expect(reports[1]?.sourceIds).toEqual(["fred.TESTPCT"]);
    expect(reports[1]?.ingestedAt).toBe(utc("2026-12-01T12:00:00Z"));

    const store = new ArtifactStore(h.config.artifactsDir, h.db);
    expect(store.count()).toBe(5);
    const hashes = new Set((h.db.prepare("SELECT hash FROM artifacts").all() as { hash: string }[]).map((r) => r.hash));
    const obsHashes = (h.db.prepare("SELECT DISTINCT raw_content_hash AS h FROM observations").all() as { h: string }[]).map((r) => r.h);
    expect(obsHashes.length).toBe(5);
    for (const hsh of obsHashes) {
      expect(hashes.has(hsh)).toBe(true);
      expect(store.verify(hsh).ok).toBe(true);
    }
    expect((h.db.prepare("SELECT count(*) AS n FROM observations").get() as { n: number }).n).toBe(20);

    const ledger = new Ledger(h.db);
    const events = ledger.events().filter((e) => e.kind === "ingest.completed");
    expect(events).toHaveLength(4);
    expect(events[3]?.payload).toMatchObject({ source: "alpaca-bars", artifacts: 2, observations: 5, requestCount: 2 });
    expect(ledger.verifyChain().ok).toBe(true);

    // The transport saw the credentials; nothing stored did.
    expect(h.requests.some((r) => r.url.includes(FRED_KEY))).toBe(true);
    expect(h.requests.some((r) => r.headers["APCA-API-SECRET-KEY"] === ALPACA_SECRET)).toBe(true);
    expect(h.requests.every((r) => r.headers["user-agent"] === `BlackGold/0.1.0 (${CONTACT})`)).toBe(true);
    const stored = allStoredText(h.db);
    for (const secret of [FRED_KEY, ALPACA_ID, ALPACA_SECRET]) expect(stored).not.toContain(secret);
    expect(JSON.stringify(reports)).not.toContain(FRED_KEY);
    expect(JSON.stringify(reports)).not.toContain(ALPACA_SECRET);
    h.db.close();
  });

  it("deduplicates everything on a second identical run", async () => {
    const h = harness();
    const deps = { db: h.db, config: h.config, calendar, clock, fetchImpl: h.fetchImpl };
    for (const req of REQUESTS) await runIngest(deps, req);
    const before = (h.db.prepare("SELECT count(*) AS n FROM observations").get() as { n: number }).n;
    const again = [];
    for (const req of REQUESTS) again.push(await runIngest(deps, req));
    for (const r of again) {
      expect(r.deduplicated).toBe(r.observations);
      expect(r.artifactsDeduplicated).toBe(r.artifacts);
      expect(r.conflicts).toBe(0);
    }
    expect((h.db.prepare("SELECT count(*) AS n FROM observations").get() as { n: number }).n).toBe(before);
    expect(new ArtifactStore(h.config.artifactsDir, h.db).count()).toBe(5);
    expect(new Ledger(h.db).events().filter((e) => e.kind === "ingest.completed")).toHaveLength(8);
    h.db.close();
  });

  it("refuses to ingest without the SEC contact before any request", async () => {
    const h = harness({ secUserAgentContact: undefined });
    await expect(runIngest({ db: h.db, config: h.config, calendar, clock, fetchImpl: h.fetchImpl }, FRED_REQUEST)).rejects.toThrow(MissingSourceCredentialError);
    expect(h.requests).toHaveLength(0);
    h.db.close();
  });

  it("refuses when the artifact store exceeds its budget and records the refusal", async () => {
    const h = harness();
    const deps = { db: h.db, config: h.config, calendar, clock, fetchImpl: h.fetchImpl };
    await runIngest(deps, SEC_REQUEST);
    const tight = { ...h.config, sources: { ...h.config.sources, artifactBudgetBytes: 1 } };
    await expect(runIngest({ ...deps, config: tight }, FRED_REQUEST)).rejects.toThrow(ArtifactBudgetExceededError);
    const refused = new Ledger(h.db).events().filter((e) => e.kind === "ingest.refused_budget");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.payload).toMatchObject({ source: "fred", budgetBytes: 1 });
    expect(h.requests).toHaveLength(1); // the refused run made no request
    h.db.close();
  });
});

describe("ingest CLI arguments", () => {
  it("parses each source's options", () => {
    expect(parseIngestArgs(["sec-submissions", "--cik", "320193"])).toEqual({ source: "sec-submissions", cik: "320193" });
    expect(parseIngestArgs(["fred", "--series", "CPIAUCSL", "--realtime-start", "2020-01-01"])).toEqual({ source: "fred", seriesId: "CPIAUCSL", realtimeStart: "2020-01-01", realtimeEnd: undefined });
    expect(parseIngestArgs(["cot", "--dataset", "legacy_futures", "--from", "2026-06-01"])).toEqual({ source: "cot", dataset: "legacy_futures", marketCode: undefined, from: "2026-06-01", to: undefined });
    expect(parseIngestArgs(["alpaca-bars", "--symbols", "VTI,SPY", "--start", "2026-01-02", "--end", "2026-01-31"])).toEqual({ source: "alpaca-bars", symbols: ["VTI", "SPY"], start: "2026-01-02", end: "2026-01-31" });
  });

  it("rejects unknown sources, missing required options, bad dates, and unknown flags", () => {
    expect(() => parseIngestArgs(["schwab"])).toThrow(UsageError);
    expect(() => parseIngestArgs(["sec-submissions"])).toThrow(UsageError);
    expect(() => parseIngestArgs(["fred", "--series", "X", "--realtime-start", "2020-13-01"])).toThrow(UsageError);
    expect(() => parseIngestArgs(["cot", "--dataset", "options"])).toThrow(UsageError);
    expect(() => parseIngestArgs(["alpaca-bars", "--symbols", "SPY", "--start", "2026-01-02"])).toThrow(UsageError);
    expect(() => parseIngestArgs(["alpaca-bars", "--symbols", "SPY", "--start", "2026-01-02", "--end", "2026-01-31", "--live"])).toThrow(UsageError);
  });
});
