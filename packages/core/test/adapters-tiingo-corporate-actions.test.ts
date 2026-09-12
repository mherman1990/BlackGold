import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, sha256Hex, utc } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { parseAppConfig } from "../src/config/load.ts";
import { ArtifactStore } from "../src/data/artifacts/store.ts";
import { AllowlistedHttpClient, PUBLIC_SOURCE_HOSTS, PUBLIC_SOURCE_RATES, type FetchLike } from "../src/data/http.ts";
import { PointInTimeRepository } from "../src/data/pit/repository.ts";
import { openCoreDb } from "../src/db/open.ts";
import { MissingSourceCredentialError } from "../src/errors.ts";
import { corporateActionFromValue, corporateActionSourceId, rawBarFromValue } from "../src/market/types.ts";
import { TotalReturnSeries } from "../src/market/series.ts";
import { blocksPromotionEvidence, isQualityCode } from "../src/data/quality.ts";
import { SchemaDriftError } from "../src/data/adapters/common.ts";
import { UNVERIFIED_SINGLE_SOURCE } from "../src/data/adapters/corporate-actions.ts";
import { parseIngestArgs, runIngest, UsageError } from "../src/ingest/run.ts";
import { ADAPTER_VERSION, PARSER_VERSION, fetchTiingoCorporateActions, parseTiingoCorporateActions } from "../src/data/adapters/tiingo-corporate-actions.ts";

const calendar = new NyseCalendar();
const ingestedAt = utc("2026-12-01T00:00:00Z");
const KEY = "fake-tiingo-key-0123456789";
const bytesOf = (rows: unknown[]): Uint8Array => new TextEncoder().encode(JSON.stringify(rows));
const ctxFor = (b: Uint8Array, symbol = "VTI") => ({ calendar, ingestedAt, rawContentHash: `sha256:${sha256Hex(b)}`, symbol });
const toBuf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

// One row per session; a Tiingo prices row always carries divCash and splitFactor plus the OHLCV that this
// adapter ignores. `divCash: 0, splitFactor: 1` is the ordinary no-action row.
const row = (date: string, divCash: number | string, splitFactor: number | string): Record<string, unknown> => ({
  date: `${date}T00:00:00.000Z`,
  close: 100,
  open: 100,
  high: 101,
  low: 99,
  volume: 1000,
  adjClose: 100,
  divCash,
  splitFactor,
});

describe("Tiingo corporate-action parser", () => {
  it("maps a divCash row to a CASH_DIVIDEND flagged UNVERIFIED_SINGLE_SOURCE, with ex-date provenance", () => {
    const bytes = bytesOf([row("2018-12-20", 0, 1), row("2018-12-24", "0.75", 1)]);
    const obs = parseTiingoCorporateActions(bytes, ctxFor(bytes));
    expect(obs).toHaveLength(1); // the 0/1 row produces nothing
    const div = obs[0];
    if (!div) throw new Error("missing dividend");
    expect(div.sourceId).toBe(corporateActionSourceId("CASH_DIVIDEND"));
    expect(div.entityId).toBe("VTI");
    expect(div.effectiveAt).toBe("2018-12-24T00:00:00.000Z");
    expect(div.availableAt).toBe("2018-12-24T00:00:00.000Z"); // ex-date start (conservative; feed names no announcement)
    expect(div.sourceLocator).toBe("tiingo/corporate-actions/VTI/CASH_DIVIDEND/2018-12-24");
    expect(div.rawContentHash).toBe(`sha256:${sha256Hex(bytes)}`);
    expect(div.adapterVersion).toBe(ADAPTER_VERSION);
    expect(div.parserVersion).toBe(PARSER_VERSION);
    expect(div.qualityFlags).toEqual([UNVERIFIED_SINGLE_SOURCE]);

    const action = corporateActionFromValue(div.value);
    if (action.kind !== "CASH_DIVIDEND") throw new Error("expected dividend");
    expect(action.amount.toFixed()).toBe("0.75");
    expect(action.exDate).toBe("2018-12-24");
    expect(action.payDate).toBe("2018-12-24"); // feed carries no pay date; defaults to ex-date (payDate >= exDate)
    expect(action.qualified).toBe(false); // tax-conservative unknown
  });

  it("maps splitFactor to a SPLIT ratio, forward and reverse, and treats 1 as no split", () => {
    const bytes = bytesOf([row("2005-06-21", 0, 2), row("2010-01-04", 0, "0.1"), row("2011-02-01", 0, "1.0")]);
    const obs = parseTiingoCorporateActions(bytes, ctxFor(bytes));
    expect(obs).toHaveLength(2);
    const [f, r] = obs;
    if (!f || !r) throw new Error("expected two splits");
    const forward = corporateActionFromValue(f.value);
    const reverse = corporateActionFromValue(r.value);
    if (forward.kind !== "SPLIT" || reverse.kind !== "SPLIT") throw new Error("expected splits");
    expect(forward.ratio.toFixed()).toBe("2");
    expect(forward.exDate).toBe("2005-06-21");
    expect(reverse.ratio.toFixed()).toBe("0.1"); // 1:10 reverse split
    expect(obs.every((o) => o.qualityFlags.includes(UNVERIFIED_SINGLE_SOURCE))).toBe(true);
  });

  it("emits both a dividend and a split when a single row carries each", () => {
    const bytes = bytesOf([row("2016-06-17", "0.50", 3)]);
    const obs = parseTiingoCorporateActions(bytes, ctxFor(bytes));
    expect(obs.map((o) => o.sourceId).sort()).toEqual([corporateActionSourceId("CASH_DIVIDEND"), corporateActionSourceId("SPLIT")]);
    expect(obs.map((o) => o.sourceLocator).sort()).toEqual(["tiingo/corporate-actions/VTI/CASH_DIVIDEND/2016-06-17", "tiingo/corporate-actions/VTI/SPLIT/2016-06-17"]);
  });

  it("produces nothing for the all-no-action series and honours an entity-id mapping", () => {
    const quiet = bytesOf([row("2018-01-02", 0, 1), row("2018-01-03", "0", "1")]);
    expect(parseTiingoCorporateActions(quiet, ctxFor(quiet))).toHaveLength(0);
    const bytes = bytesOf([row("2018-12-24", "0.75", 1)]);
    const obs = parseTiingoCorporateActions(bytes, { ...ctxFor(bytes, "vti"), entityIds: { VTI: "etf:vti" } });
    expect(obs[0]?.entityId).toBe("etf:vti");
    expect(obs[0]?.sourceLocator).toBe("tiingo/corporate-actions/etf:vti/CASH_DIVIDEND/2018-12-24");
  });

  it("rejects corrupt values, duplicates, and non-conforming payloads as SCHEMA_DRIFT", () => {
    const bad = (rows: unknown[]) => () => parseTiingoCorporateActions(bytesOf(rows), ctxFor(bytesOf(rows)));
    expect(bad([row("2018-12-24", -0.1, 1)])).toThrow(SchemaDriftError); // negative dividend, not a silent no-action
    expect(bad([row("2018-12-24", 0, 0)])).toThrow(SchemaDriftError); // splitFactor 0
    expect(bad([row("2018-12-24", 0, -2)])).toThrow(SchemaDriftError); // negative splitFactor
    expect(bad([row("2018-12-24", "abc", 1)])).toThrow(SchemaDriftError); // non-decimal divCash
    expect(bad([{ date: "2018-12-24T00:00:00Z", splitFactor: 1 }])).toThrow(SchemaDriftError); // divCash field missing
    // Same entity, kind and ex-date twice in one payload.
    expect(bad([row("2018-12-24", "0.5", 1), row("2018-12-24", "0.6", 1)])).toThrow(SchemaDriftError);
    const junk = new TextEncoder().encode("{not json");
    expect(() => parseTiingoCorporateActions(junk, ctxFor(junk))).toThrow(SchemaDriftError);
  });

  it("registers the single-source flag with the quality policy so it bars promotion evidence", () => {
    const bytes = bytesOf([row("2018-12-24", "0.75", 1)]);
    const obs = parseTiingoCorporateActions(bytes, ctxFor(bytes));
    expect(obs[0]?.qualityFlags).toContain(UNVERIFIED_SINGLE_SOURCE);
    expect(isQualityCode(UNVERIFIED_SINGLE_SOURCE)).toBe(true);
    expect(blocksPromotionEvidence([UNVERIFIED_SINGLE_SOURCE])).toEqual([UNVERIFIED_SINGLE_SOURCE]);
  });

  it("feeds a total-return distribution the shared series builder consumes", () => {
    const bytes = bytesOf([row("2018-12-24", "1.00", 1)]);
    const parsed = parseTiingoCorporateActions(bytes, ctxFor(bytes));
    const first = parsed[0];
    if (!first) throw new Error("missing dividend");
    const div = corporateActionFromValue(first.value);
    const bar = (session: string, close: number) => rawBarFromValue({ symbol: "VTI", session, open: close, high: close, low: close, close, volume: 1000, venue: "tiingo" });
    // Two flat $100 closes with a $1 dividend going ex on the second: the TR index rises by 1% from the reinvested cash.
    const tr = TotalReturnSeries.build([bar("2018-12-21", 100), bar("2018-12-24", 100)], [div], "VTI");
    expect(tr.points).toHaveLength(2);
    expect(tr.points[1]?.distribution.toFixed()).toBe("1");
    expect(tr.points[1]?.trIndex.toFixed(4)).toBe("1.0100");
  });
});

describe("Tiingo corporate-action fetch", () => {
  const prices = bytesOf([row("2018-12-24", "0.75", 1), row("2005-06-21", 0, 2)]);
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    requests.push({ url, headers: init.headers });
    const u = new URL(url);
    const body = u.hostname === "api.tiingo.com" ? prices : new Uint8Array();
    return Promise.resolve({ status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(toBuf(body)) });
  };

  it("hits the same prices endpoint, sends the token only in a header, and scrubs it from stored data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-tiingo-ca-"));
    const config = parseAppConfig({ dataDir: dir, sources: { tiingoApiKey: KEY } });
    const { db } = openCoreDb(config);
    const client = new AllowlistedHttpClient({ allowlist: PUBLIC_SOURCE_HOSTS, ratePerSecond: PUBLIC_SOURCE_RATES, userAgent: "BlackGold/0.1.0 (ops@example.invalid)", fetchImpl });
    const store = new ArtifactStore(config.artifactsDir, db);

    const outcome = await fetchTiingoCorporateActions(client, store, { calendar, ingestedAt, apiKey: KEY, symbols: ["VTI"], start: "2000-01-01" as never, end: "2018-12-31" as never });
    expect(outcome.observations).toHaveLength(2); // one dividend, one split
    expect(outcome.artifacts).toHaveLength(1);
    expect(requests[0]?.url).toContain("/tiingo/daily/vti/prices");
    expect(requests[0]?.headers["Authorization"]).toBe(`Token ${KEY}`);
    expect(requests[0]?.url).not.toContain(KEY);

    const stored = [
      ...(db.prepare("SELECT source_locator, value_json FROM observations").all() as Record<string, string>[]).map((r) => Object.values(r).join("\n")),
      ...(db.prepare("SELECT first_locator, path FROM artifacts").all() as Record<string, string>[]).map((r) => Object.values(r).join("\n")),
    ].join("\n");
    expect(stored).not.toContain(KEY);
    db.close();
  });

  it("refuses to fetch without the Tiingo key before any request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-tiingo-ca-"));
    const config = parseAppConfig({ dataDir: dir });
    const { db } = openCoreDb(config);
    const client = new AllowlistedHttpClient({ allowlist: PUBLIC_SOURCE_HOSTS, ratePerSecond: PUBLIC_SOURCE_RATES, userAgent: "BlackGold/0.1.0 (ops@example.invalid)", fetchImpl });
    const store = new ArtifactStore(config.artifactsDir, db);
    await expect(fetchTiingoCorporateActions(client, store, { calendar, ingestedAt, symbols: ["VTI"], start: "2000-01-01" as never, end: "2018-12-31" as never })).rejects.toThrow(MissingSourceCredentialError);
    db.close();
  });

  it("is readable through the point-in-time path only on or after the ex-date, and runs through runIngest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-tiingo-ca-"));
    const config = parseAppConfig({ dataDir: dir, sources: { tiingoApiKey: KEY, secUserAgentContact: "ops@example.invalid" } });
    const { db } = openCoreDb(config);

    const report = await runIngest({ db, config, calendar, fetchImpl }, { source: "tiingo-actions", symbols: ["VTI"], start: isoDate("2000-01-01"), end: isoDate("2018-12-31") });
    expect(report.source).toBe("tiingo-actions");
    expect(report.observations).toBe(2);
    expect(report.sourceIds.sort()).toEqual([corporateActionSourceId("CASH_DIVIDEND"), corporateActionSourceId("SPLIT")]);

    const repo = new PointInTimeRepository(db);
    const before = repo.asOf({ sourceId: corporateActionSourceId("CASH_DIVIDEND"), entityId: "VTI", decisionAt: utc("2018-12-23T23:00:00Z") });
    expect(before.rows).toHaveLength(0);
    const after = repo.asOf({ sourceId: corporateActionSourceId("CASH_DIVIDEND"), entityId: "VTI", decisionAt: utc("2018-12-25T00:00:00Z") });
    expect(after.rows).toHaveLength(1);
    db.close();
  });
});

describe("tiingo-actions CLI arguments", () => {
  it("parses --symbols/--start/--end", () => {
    expect(parseIngestArgs(["tiingo-actions", "--symbols", "VTI,QQQ", "--start", "2000-01-01", "--end", "2018-12-31"])).toEqual({
      source: "tiingo-actions",
      symbols: ["VTI", "QQQ"],
      start: "2000-01-01",
      end: "2018-12-31",
    });
  });

  it("requires --symbols/--start/--end and rejects unknown flags", () => {
    expect(() => parseIngestArgs(["tiingo-actions", "--symbols", "VTI"])).toThrow(UsageError);
    expect(() => parseIngestArgs(["tiingo-actions", "--symbols", "VTI", "--start", "2000-01-01", "--end", "2018-12-31", "--live"])).toThrow(UsageError);
  });
});
