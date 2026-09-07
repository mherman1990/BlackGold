import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareInstants, isoDate, sha256Hex, utc, addDays } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { ArtifactStore } from "../src/data/artifacts/store.ts";
import { AllowlistedHttpClient, type FetchLike } from "../src/data/http.ts";
import { thirteenFDeadline } from "../src/data/lag-rules.ts";
import { PointInTimeRepository } from "../src/data/pit/repository.ts";
import { openCoreDb } from "../src/db/open.ts";
import { MissingSourceCredentialError } from "../src/errors.ts";
import { SchemaDriftError } from "../src/data/adapters/common.ts";
import {
  ADAPTER_VERSION,
  fetchForm4Document,
  fetchSubmissions,
  PARSER_VERSION,
  parseForm4Xml,
  parseSubmissions,
  primaryDocumentUrl,
  SEC_FORM4_SOURCE_ID,
  SEC_SUBMISSIONS_SOURCE_ID,
  submissionsUrl,
} from "../src/data/adapters/sec-edgar.ts";

const FIXTURES = new URL("../../../test/fixtures/sec/", import.meta.url);
const submissionsBytes = new Uint8Array(readFileSync(new URL("submissions-CIK0000012345.json", FIXTURES)));
const form4Bytes = new Uint8Array(readFileSync(new URL("form4-0000012345-26-000022.xml", FIXTURES)));
const calendar = new NyseCalendar();
const ingestedAt = utc("2026-09-07T00:00:00Z");
const ctxFor = (bytes: Uint8Array) => ({ calendar, ingestedAt, rawContentHash: `sha256:${sha256Hex(bytes)}` });

function byAccession(rows: ReturnType<typeof parseSubmissions>, sourceId: string, accession: string) {
  const row = rows.find((r) => r.sourceId === sourceId && r.sourceLocator === accession);
  if (!row) throw new Error(`missing ${sourceId} ${accession}`);
  return row;
}

describe("SEC EDGAR submissions parser", () => {
  const rows = parseSubmissions(submissionsBytes, ctxFor(submissionsBytes));

  it("emits one submissions row per filing plus an index-level form4 row for 4 and 4/A", () => {
    expect(rows.filter((r) => r.sourceId === SEC_SUBMISSIONS_SOURCE_ID)).toHaveLength(6);
    expect(rows.filter((r) => r.sourceId === SEC_FORM4_SOURCE_ID)).toHaveLength(2);
    for (const r of rows) {
      expect(r.entityId).toBe("cik:0000012345");
      expect(r.sourceLocator).toMatch(/^\d{10}-\d{2}-\d{6}$/);
      expect(r.rawContentHash).toBe(`sha256:${sha256Hex(submissionsBytes)}`);
      expect(r.adapterVersion).toBe(ADAPTER_VERSION);
      expect(r.parserVersion).toBe(PARSER_VERSION);
      expect(r.ingestedAt).toBe(ingestedAt);
    }
  });

  it("Wednesday 18:10 ET acceptance disseminates Thursday 06:00 ET (10:00Z) with AFTER_HOURS_ACCEPTANCE", () => {
    const sub = byAccession(rows, SEC_SUBMISSIONS_SOURCE_ID, "0000012345-26-000022");
    expect(sub.availableAt).toBe("2026-03-12T10:00:00.000Z");
    expect(sub.qualityFlags).toEqual(["AFTER_HOURS_ACCEPTANCE"]);
    expect(sub.observedAt).toBe("2026-03-06T00:00:00.000Z"); // reportDate
    expect(sub.value.acceptanceAt).toBe("2026-03-11T22:10:07.000Z");
    expect(sub.value.form).toBe("4");
    const f4 = byAccession(rows, SEC_FORM4_SOURCE_ID, "0000012345-26-000022");
    expect(f4.observedAt).toBe("2026-03-11T00:00:00.000Z"); // filing date: the index has no transaction date
    expect(f4.availableAt).toBe("2026-03-12T10:00:00.000Z");
    expect(f4.qualityFlags).toEqual(["AFTER_HOURS_ACCEPTANCE"]);
  });

  it("in-hours acceptance is available at the acceptance instant with no flags; 17:29:59 ET is inside the cutoff", () => {
    const tenK = byAccession(rows, SEC_SUBMISSIONS_SOURCE_ID, "0000012345-26-000009");
    expect(tenK.availableAt).toBe("2026-02-20T21:05:33.000Z");
    expect(tenK.qualityFlags).toEqual([]);
    expect(tenK.observedAt).toBe("2025-12-31T00:00:00.000Z");
    expect(tenK.value.isXbrl).toBe(true);
    const tenQ = byAccession(rows, SEC_SUBMISSIONS_SOURCE_ID, "0000012345-26-000038");
    expect(tenQ.availableAt).toBe("2026-05-06T21:29:59.000Z");
    expect(tenQ.qualityFlags).toEqual([]);
  });

  it("13F-HR filed on day 45 is unavailable at quarter end + 44 days and inside the deadline", () => {
    const f = byAccession(rows, SEC_SUBMISSIONS_SOURCE_ID, "0000012345-26-000041");
    expect(f.availableAt).toBe("2026-05-15T19:02:11.000Z");
    const quarterEnd = isoDate("2026-03-31");
    expect(compareInstants(f.availableAt, utc(`${addDays(quarterEnd, 44)}T23:59:59Z`))).toBeGreaterThan(0);
    expect(compareInstants(f.availableAt, thirteenFDeadline(quarterEnd))).toBeLessThanOrEqual(0);
    expect(f.value.items).toBeNull();
  });

  it("Saturday acceptance disseminates Monday 06:00 ET", () => {
    const k = byAccession(rows, SEC_SUBMISSIONS_SOURCE_ID, "0000012345-26-000031");
    expect(k.availableAt).toBe("2026-04-13T10:00:00.000Z");
    expect(k.qualityFlags).toEqual(["AFTER_HOURS_ACCEPTANCE"]);
    expect(k.value.items).toBe("2.02,9.01");
  });

  it("marks 4/A amendment rows AMENDED on both the submissions and the form4 index rows", () => {
    const a = byAccession(rows, SEC_SUBMISSIONS_SOURCE_ID, "0000012345-26-000027");
    expect(a.value.isAmendment).toBe(true);
    expect(a.qualityFlags).toEqual(["AMENDED"]);
    expect(a.availableAt).toBe("2026-03-13T14:00:00.000Z");
    expect(byAccession(rows, SEC_FORM4_SOURCE_ID, "0000012345-26-000027").qualityFlags).toEqual(["AMENDED"]);
  });

  it("is a pure function of bytes, context, and parser version", () => {
    expect(JSON.stringify(parseSubmissions(submissionsBytes, ctxFor(submissionsBytes)))).toBe(JSON.stringify(rows));
  });

  it("rejects payloads that drift from the schema and never writes partial rows", () => {
    const bad = new TextEncoder().encode(JSON.stringify({ cik: "1", filings: { recent: { accessionNumber: ["0000000001-26-000001"], filingDate: [] } } }));
    expect(() => parseSubmissions(bad, ctxFor(bad))).toThrow(SchemaDriftError);
    const notJson = new TextEncoder().encode("<html>rate limited</html>");
    expect(() => parseSubmissions(notJson, ctxFor(notJson))).toThrow(SchemaDriftError);
  });

  it("every row passes the repository's temporal-inversion check", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-sec-"));
    const { db } = openCoreDb({ dbPath: join(dir, "x.sqlite") });
    const results = new PointInTimeRepository(db).appendMany(rows);
    expect(results.every((r) => !r.deduplicated && !r.conflict)).toBe(true);
    db.close();
  });
});

describe("Form 4 XML parser", () => {
  const acceptanceAt = utc("2026-03-11T22:10:07Z"); // 18:10:07 ET Wednesday, from the submissions index
  const base = { ...ctxFor(form4Bytes), accessionNumber: "0000012345-26-000022", acceptanceAt, form: "4" };
  const rows = parseForm4Xml(form4Bytes, base);

  it("emits one observation per non-derivative transaction with observedAt = transaction date", () => {
    expect(rows).toHaveLength(2);
    const [buy, sell] = rows;
    expect(buy?.sourceId).toBe(SEC_FORM4_SOURCE_ID);
    expect(buy?.sourceLocator).toBe("0000012345-26-000022/nonDerivativeTransaction/1");
    expect(sell?.sourceLocator).toBe("0000012345-26-000022/nonDerivativeTransaction/2");
    expect(buy?.entityId).toBe("cik:0000012345");
    expect(buy?.observedAt).toBe("2026-03-06T00:00:00.000Z");
    expect(sell?.observedAt).toBe("2026-03-09T00:00:00.000Z");
    for (const r of rows) expect(r.availableAt).toBe("2026-03-12T10:00:00.000Z");
  });

  it("flags LATE_FILING only when acceptance passes the second-business-day 22:00 ET deadline", () => {
    const [buy, sell] = rows;
    // Friday 03-06 transaction: deadline Tuesday 03-10 22:00 ET; accepted Wednesday -> late.
    expect(buy?.qualityFlags).toEqual(["AFTER_HOURS_ACCEPTANCE", "LATE_FILING"]);
    // Monday 03-09 transaction: deadline Wednesday 03-11 22:00 ET; accepted 18:10 ET Wednesday -> on time.
    expect(sell?.qualityFlags).toEqual(["AFTER_HOURS_ACCEPTANCE"]);
  });

  it("carries decimal strings, codes, and the 10b5-1 flag (transaction-level overrides document-level)", () => {
    const [buy, sell] = rows;
    expect(buy?.value).toMatchObject({
      issuerCik: "0000012345",
      issuerTradingSymbol: "EXWG",
      reportingOwnerCik: "0000054321",
      transactionCode: "P",
      shares: "1000",
      pricePerShare: "52.1",
      acquiredDisposed: "A",
      sharesOwnedAfter: "11000",
      isDerivative: false,
      is10b51: false,
      directOrIndirect: "D",
      securityTitle: "Common Stock",
    });
    expect(sell?.value).toMatchObject({ transactionCode: "S", shares: "250", pricePerShare: "53.005", acquiredDisposed: "D", sharesOwnedAfter: "10750", is10b51: true });
    for (const r of rows) {
      expect(typeof r.value.shares).toBe("string");
      expect(typeof r.value.pricePerShare).toBe("string");
    }
  });

  it("marks 4/A rows AMENDED and is deterministic", () => {
    const amended = parseForm4Xml(form4Bytes, { ...base, form: "4/A" });
    expect(amended[0]?.qualityFlags).toEqual(["AFTER_HOURS_ACCEPTANCE", "AMENDED", "LATE_FILING"]);
    expect(JSON.stringify(parseForm4Xml(form4Bytes, base))).toBe(JSON.stringify(rows));
  });

  it("rejects a document without an ownershipDocument root", () => {
    const bad = new TextEncoder().encode("<html></html>");
    expect(() => parseForm4Xml(bad, { ...base, rawContentHash: `sha256:${sha256Hex(bad)}` })).toThrow(SchemaDriftError);
  });
});

describe("SEC fetchers", () => {
  const requested: { url: string; ua: string }[] = [];
  const fakeFetch: FetchLike = (url, init) => {
    requested.push({ url, ua: init.headers["user-agent"] ?? "" });
    const body = url.endsWith(".xml") ? form4Bytes : submissionsBytes;
    return Promise.resolve({ status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)) });
  };
  const client = new AllowlistedHttpClient({ allowlist: ["data.sec.gov", "www.sec.gov"], userAgent: "BlackGold/0.1.0 (ops@example.invalid)", fetchImpl: fakeFetch, sleep: () => Promise.resolve() });
  const dir = mkdtempSync(join(tmpdir(), "bg-secfetch-"));
  const { db } = openCoreDb({ dbPath: join(dir, "x.sqlite") });
  const store = new ArtifactStore(join(dir, "artifacts"), db);

  it("refuses to run without a declared contact before any request", async () => {
    requested.length = 0;
    await expect(fetchSubmissions(client, store, "12345", { calendar, ingestedAt })).rejects.toThrow(MissingSourceCredentialError);
    expect(requested).toHaveLength(0);
  });

  it("stores the raw response and links every observation to it by hash", async () => {
    const out = await fetchSubmissions(client, store, 12345, { calendar, ingestedAt, userAgentContact: "ops@example.invalid" });
    expect(requested[0]?.url).toBe(submissionsUrl(12345));
    expect(requested[0]?.url).toBe("https://data.sec.gov/submissions/CIK0000012345.json");
    expect(requested[0]?.ua).toBe("BlackGold/0.1.0 (ops@example.invalid)");
    expect(out.artifacts).toHaveLength(1);
    const hash = out.artifacts[0]?.hash ?? "";
    expect(hash).toBe(`sha256:${sha256Hex(submissionsBytes)}`);
    expect(Buffer.from(store.get(hash)).equals(Buffer.from(submissionsBytes))).toBe(true);
    expect(out.observations).toHaveLength(8);
    expect(out.observations.every((o) => o.rawContentHash === hash)).toBe(true);
  });

  it("fetches a Form 4 primary document from the archive path and parses its transactions", async () => {
    const url = primaryDocumentUrl("0000012345", "0000012345-26-000022", "form4-20260311.xml");
    expect(url).toBe("https://www.sec.gov/Archives/edgar/data/12345/000001234526000022/form4-20260311.xml");
    const out = await fetchForm4Document(client, store, {
      calendar,
      ingestedAt,
      userAgentContact: "ops@example.invalid",
      cik: "12345",
      accessionNumber: "0000012345-26-000022",
      primaryDocument: "form4-20260311.xml",
      acceptanceAt: utc("2026-03-11T22:10:07Z"),
      form: "4",
    });
    expect(out.observations).toHaveLength(2);
    expect(out.observations[0]?.rawContentHash).toBe(`sha256:${sha256Hex(form4Bytes)}`);
    expect(() => primaryDocumentUrl("12345", "0000012345-26-000022", "../etc/passwd")).toThrow(TypeError);
  });
});
