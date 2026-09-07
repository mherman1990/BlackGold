import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, sha256Hex, utc } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { ArtifactStore } from "../src/data/artifacts/store.ts";
import { AllowlistedHttpClient, type FetchLike } from "../src/data/http.ts";
import { PointInTimeRepository } from "../src/data/pit/repository.ts";
import { openCoreDb } from "../src/db/open.ts";
import { SchemaDriftError } from "../src/data/adapters/common.ts";
import { COT_SOCRATA_DATASET_IDS, cotRequestUrl, fetchCot, parseCot, type CotRow } from "../src/data/adapters/cftc-cot.ts";

const FIXTURES = new URL("../../../test/fixtures/cftc/", import.meta.url);
const bytes = new Uint8Array(readFileSync(new URL("legacy-futures-three-weeks.json", FIXTURES)));
const calendar = new NyseCalendar();
const ingestedAt = utc("2026-09-07T00:00:00Z");
const ctx = { calendar, ingestedAt, rawContentHash: `sha256:${sha256Hex(bytes)}`, dataset: "legacy_futures" as const };
const toBuf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe("CFTC COT parser", () => {
  const rows = parseCot(bytes, ctx);
  const byDate = (d: string) => {
    const r = rows.find((x) => x.value.reportDate === d);
    if (!r) throw new Error(`missing ${d}`);
    return r;
  };

  it("uses Friday 15:30 ET as availability: 20:30Z in winter, 19:30Z in summer", () => {
    expect(rows).toHaveLength(3);
    const winter = byDate("2026-01-13");
    expect(winter.availableAt).toBe("2026-01-16T20:30:00.000Z");
    expect(winter.qualityFlags).toEqual([]);
    const summer = byDate("2026-06-23");
    expect(summer.availableAt).toBe("2026-06-26T19:30:00.000Z");
    expect(summer.qualityFlags).toEqual([]);
  });

  it("moves a holiday-Friday release to Monday and flags RELEASE_DELAYED", () => {
    const holiday = byDate("2026-06-30"); // Friday 2026-07-03 is the observed Independence Day holiday
    expect(holiday.availableAt).toBe("2026-07-06T19:30:00.000Z");
    expect(holiday.qualityFlags).toEqual(["RELEASE_DELAYED"]);
    expect(holiday.observedAt).toBe("2026-06-30T00:00:00.000Z");
    expect(holiday.effectiveAt).toBe("2026-06-30T00:00:00.000Z");
  });

  it("identifies rows by contract market code and keeps positions as decimal strings", () => {
    const r = byDate("2026-06-30");
    expect(r.sourceId).toBe("cftc.cot.legacy_futures");
    expect(r.entityId).toBe("099741");
    expect(r.sourceLocator).toBe("cftc/cot/legacy_futures/099741/2026-06-30");
    expect(r.value.positions["open_interest_all"]).toBe("158750");
    expect(r.value.positions["noncomm_positions_long_all"]).toBe("44100"); // provider sent a JSON number here
    expect(r.value.positions["noncomm_postions_spread_all"]).toBe("13000");
    expect(r.value.positions["comm_positions_short_all"]).toBe("88000");
    expect(r.value.positions["pct_of_oi_noncomm_long_all"]).toBe("27.8");
    expect(r.value.positions["change_in_open_interest_all"]).toBe("-2250");
    expect(Object.keys(r.value.positions)).not.toContain("id");
    expect(Object.keys(r.value.positions)).not.toContain("market_and_exchange_names");
    expect(Object.values(r.value.positions).every((v) => typeof v === "string")).toBe(true);
    expect(r.value.marketAndExchangeNames).toBe("EXAMPLE INDEX - TEST EXCHANGE");
    expect(r.value.contractUnits).toBe("(INDEX X $50)");
  });

  it("anchors a non-Tuesday report date to that week's schedule and marks the instant estimated", () => {
    const odd = new TextEncoder().encode(JSON.stringify([{ report_date_as_yyyy_mm_dd: "2026-09-09T00:00:00.000", cftc_contract_market_code: "099741", open_interest_all: "1" }]));
    const [r] = parseCot(odd, { ...ctx, rawContentHash: `sha256:${sha256Hex(odd)}` });
    expect(r?.availableAt).toBe("2026-09-18T19:30:00.000Z");
    expect(r?.qualityFlags).toEqual(["AVAILABLE_AT_ESTIMATED"]);
  });

  it("is deterministic and rejects schema drift", () => {
    expect(JSON.stringify(parseCot(bytes, ctx))).toBe(JSON.stringify(rows));
    const bad = new TextEncoder().encode(JSON.stringify([{ foo: 1 }]));
    expect(() => parseCot(bad, { ...ctx, rawContentHash: `sha256:${sha256Hex(bad)}` })).toThrow(SchemaDriftError);
  });

  it("appends through the repository and a Wednesday decision sees the prior week's report only", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-cot-"));
    const { db } = openCoreDb({ dbPath: join(dir, "x.sqlite") });
    const repo = new PointInTimeRepository(db);
    repo.appendMany(rows);
    const seen = repo.asOf<CotRow>({ sourceId: "cftc.cot.legacy_futures", decisionAt: utc("2026-07-01T16:00:00Z") });
    expect(seen.rows.map((r) => r.value.reportDate)).toEqual(["2026-01-13", "2026-06-23"]);
    db.close();
  });
});

describe("CFTC COT fetcher", () => {
  it("builds a Socrata query on the recorded dataset id and stores the raw page", async () => {
    const url = cotRequestUrl({ dataset: "legacy_futures", marketCode: "099741", from: isoDate("2026-06-01"), to: isoDate("2026-07-31") });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`https://publicreporting.cftc.gov/resource/${COT_SOCRATA_DATASET_IDS.legacy_futures}.json`);
    expect(u.searchParams.get("$where")).toBe("report_date_as_yyyy_mm_dd between '2026-06-01T00:00:00.000' and '2026-07-31T23:59:59.999' AND cftc_contract_market_code='099741'");
    expect(u.searchParams.get("$limit")).toBe("50000");
    expect(() => cotRequestUrl({ dataset: "tff_futures", marketCode: "x' OR 1=1" })).toThrow(TypeError);

    const requested: string[] = [];
    const fakeFetch: FetchLike = (reqUrl) => {
      requested.push(reqUrl);
      return Promise.resolve({ status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(toBuf(bytes)) });
    };
    const client = new AllowlistedHttpClient({ allowlist: ["publicreporting.cftc.gov"], userAgent: "BlackGold/0.1.0 (ops@example.invalid)", fetchImpl: fakeFetch, sleep: () => Promise.resolve() });
    const dir = mkdtempSync(join(tmpdir(), "bg-cotfetch-"));
    const { db } = openCoreDb({ dbPath: join(dir, "x.sqlite") });
    const store = new ArtifactStore(join(dir, "artifacts"), db);
    const out = await fetchCot(client, store, { calendar, ingestedAt, dataset: "legacy_futures", marketCode: "099741" });
    expect(requested).toHaveLength(1);
    expect(out.artifacts[0]?.hash).toBe(`sha256:${sha256Hex(bytes)}`);
    expect(out.observations).toHaveLength(3);
    expect(out.observations.every((o) => o.rawContentHash === out.artifacts[0]?.hash)).toBe(true);
    db.close();
  });
});
