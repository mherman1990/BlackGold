import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, utc, type Db } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { parseAppConfig, type AppConfig } from "../src/config/load.ts";
import { corporateActionsHash, parseCorporateActions, UnapprovedCorporateActionsError, UNVERIFIED_SINGLE_SOURCE } from "../src/data/adapters/corporate-actions.ts";
import { parseTiingoCorporateActions } from "../src/data/adapters/tiingo-corporate-actions.ts";
import type { FetchLike } from "../src/data/http.ts";
import { PointInTimeRepository } from "../src/data/pit/repository.ts";
import { openCoreDb } from "../src/db/open.ts";
import { parseReconcileArgs, runReconcile, ssgaNavHistoryUrl, SSGA_DISTRIBUTIONS_URL } from "../src/ingest/reconcile-corporate-actions.ts";
import { UsageError } from "../src/ingest/run.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { corporateActionFromValue } from "../src/market/types.ts";

/**
 * D-57 PR-B2: the `reconcile corporate-actions` command, end to end against the tracked charter, a store holding
 * Tiingo's rows, State Street served from synthetic workbooks, and owner files on disk. What matters: it builds the
 * file from the charter's windows with their warm-up, it writes nothing into any store but artifacts and one ledger
 * event, it never overwrites, and its report names exactly what the owner still has to curate.
 */
const CHARTER = new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url).pathname;
const FIX = new URL("../../../test/fixtures/ssga/", import.meta.url);
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, FIX)));
const toBuf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const calendar = new NyseCalendar();
const clock = (): number => Date.parse("2026-12-01T12:00:00Z");

/** Tiingo's daily rows for one symbol: only the action fields matter to the parser. */
function tiingo(db: Db, symbol: string, rows: { date: string; divCash?: number; splitFactor?: number }[]): void {
  const bytes = new TextEncoder().encode(JSON.stringify(rows.map((r) => ({ date: `${r.date}T00:00:00.000Z`, divCash: r.divCash ?? 0, splitFactor: r.splitFactor ?? 1 }))));
  const obs = parseTiingoCorporateActions(bytes, { calendar, ingestedAt: utc("2026-11-01T00:00:00Z"), rawContentHash: `sha256:${sha256Hex(bytes)}`, symbol });
  new PointInTimeRepository(db).appendMany(obs);
}

/** A vendored file already ingested into the research store: its rows share Tiingo's source ids and must not pass for Tiingo's. */
function vendoredRow(db: Db): void {
  const actions = [{ action: { kind: "CASH_DIVIDEND", entityId: "VTI", amount: "0.51", exDate: "2010-06-24", payDate: "2010-06-29", qualified: false }, sources: ["a", "b"] }];
  const bytes = new TextEncoder().encode(JSON.stringify({ dataset: "older", approval: { approvedBy: "Test Owner", approvedAt: "2026-10-01T00:00:00Z", actionsHash: corporateActionsHash(actions) }, actions }));
  new PointInTimeRepository(db).appendMany(parseCorporateActions(bytes, { calendar, ingestedAt: utc("2026-11-01T00:00:00Z"), rawContentHash: `sha256:${sha256Hex(bytes)}` }));
}

function seedResearchStore(db: Db): void {
  // Tiingo first published VTI's 2018-12-24 dividend as 0.75 and later revised it: the newest row is the one read.
  tiingo(db, "VTI", [{ date: "2018-12-24", divCash: 0.75 }]);
  vendoredRow(db);
  tiingo(db, "XLK", [{ date: "2018-09-24", divCash: 0.1981 }, { date: "2018-12-24", divCash: 0.2342 }, { date: "2025-12-02", splitFactor: 2 }]);
  tiingo(db, "XLF", [{ date: "2016-09-16", divCash: 0.1144 }, { date: "2016-09-19", divCash: 4.61 }]);
  tiingo(db, "SPY", [{ date: "2018-12-21", divCash: 1.4476 }]);
  tiingo(db, "BIL", [{ date: "2008-02-01", divCash: 0.115251 }, { date: "2008-03-03", divCash: 0.086739 }]);
  // 2010-06-24 has no issuer source: it is what the owner must curate. 2020-06-25 falls between the windows.
  tiingo(db, "VTI", [{ date: "2010-03-24", divCash: 0.49 }, { date: "2010-06-24", divCash: 0.51 }, { date: "2018-12-24", divCash: 0.7531 }, { date: "2020-06-25", divCash: 0.6 }]);
  tiingo(db, "QQQ", [{ date: "2018-12-24", divCash: 0.4 }]);
  tiingo(db, "IWM", [{ date: "2018-12-17", divCash: 0.4 }]);
}

type Harness = { dir: string; db: Db; config: AppConfig; requests: string[]; fetchImpl: FetchLike; files: Record<string, string> };

function harness(opts: { seed?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bg-reconcile-"));
  const config = parseAppConfig({ dataDir: dir, sources: { secUserAgentContact: "ops@example.invalid" } });
  const { db } = openCoreDb(config);
  if (opts.seed ?? true) seedResearchStore(db);
  const served: Record<string, Uint8Array> = {
    [SSGA_DISTRIBUTIONS_URL]: fixture("distributions.xlsx"),
    [ssgaNavHistoryUrl("XLK")]: fixture("navhist-xlk.xlsx"),
    [ssgaNavHistoryUrl("XLF")]: fixture("navhist-xlf.xlsx"),
    [ssgaNavHistoryUrl("SPY")]: fixture("navhist-spy.xlsx"),
    [ssgaNavHistoryUrl("BIL")]: fixture("navhist-bil.xlsx"),
  };
  const requests: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    requests.push(url);
    const body = served[url];
    if (body === undefined) return Promise.resolve({ status: 404, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    return Promise.resolve({ status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(toBuf(body)) });
  };
  const write = (name: string, content: string): string => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };
  const files = {
    vanguardVti: write("vti.json", JSON.stringify([{ typeCode: "INC", amount: 0.7531, payableDate: "2018-12-27", exDividendDate: "2018-12-24" }])),
    isharesIwm: write(
      "iwm.xls",
      `<?xml version="1.0"?>\n<ss:Workbook xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n<ss:Worksheet ss:Name="Holdings"><ss:Table><ss:Row><ss:Cell><ss:Data ss:Type="String">iShares Russell 2000 ETF</ss:Data></ss:Cell></ss:Row></ss:Table></ss:Worksheet>\n` +
        `<ss:Worksheet ss:Name="Distributions"><ss:Table>\n<ss:Row><ss:Cell><ss:Data ss:Type="String">Ex-Date</ss:Data></ss:Cell><ss:Cell><ss:Data ss:Type="String">Payable Date</ss:Data></ss:Cell><ss:Cell><ss:Data ss:Type="String">Total Distribution</ss:Data></ss:Cell></ss:Row>\n` +
        `<ss:Row><ss:Cell><ss:Data ss:Type="String">Dec 17, 2018</ss:Data></ss:Cell><ss:Cell><ss:Data ss:Type="String">Dec 21, 2018</ss:Data></ss:Cell><ss:Cell><ss:Data ss:Type="Number">0.4</ss:Data></ss:Cell></ss:Row>\n</ss:Table></ss:Worksheet>\n</ss:Workbook>`,
    ),
    curated: write("curated.csv", ["source,entity,kind,ex_date,value,pay_date,document", 'issuer:vanguard-annual-report,VTI,CASH_DIVIDEND,2010-03-24,0.4900,,"AR 2010, p. 14"', "issuer:invesco-notice,QQQ,CASH_DIVIDEND,2018-12-24,0.40,,Q4 2018 notice"].join("\n")),
    structural: write("structural.json", JSON.stringify({ actions: [{ action: { kind: "SPINOFF", parent: "XLF", child: "XLRE", ratio: "0.139146", exDate: "2016-09-19", childFirstClose: "33.12" }, sources: ["issuer:ssga-notice", "exchange:nyse-arca-notice"], supersedes: [{ source: "issuer:ssga-distributions", kind: "CASH_DIVIDEND" }, { source: "vendor:tiingo-eod", kind: "CASH_DIVIDEND" }] }] })),
  };
  return { dir, db, config, requests, fetchImpl, files };
}

const request = (h: Harness, over: Partial<Parameters<typeof runReconcile>[1]> = {}) => ({
  charter: CHARTER,
  out: join(h.dir, "reconciled.json"),
  report: join(h.dir, "report.json"),
  vanguard: [{ entityId: "VTI", file: h.files["vanguardVti"] ?? "" }],
  ishares: [{ entityId: "IWM", file: h.files["isharesIwm"] ?? "" }],
  curated: h.files["curated"],
  structural: h.files["structural"],
  ...over,
});
const observationCount = (db: Db): number => (db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;

describe("reconcile corporate-actions", () => {
  it("builds the unsigned file over the charter's windows with their warm-up, and reports what is left to curate", async () => {
    const h = harness();
    const before = observationCount(h.db);
    const summary = await runReconcile({ db: h.db, config: h.config, calendar, clock, fetchImpl: h.fetchImpl }, request(h));

    const file = JSON.parse(readFileSync(summary.out, "utf8")) as { approval: { approvedBy: null; approvedAt: null; actionsHash: string }; actions: { action: Record<string, unknown>; sources: string[] }[] };
    const report = JSON.parse(readFileSync(summary.report, "utf8")) as {
      windows: { segment: string; from: string; to: string; evaluatedFrom: string }[];
      toCurate: unknown[];
      vendor: { records: number; revisedActions: string[] };
      issuer: { ssgaFunds: string[]; ssgaPayDateDropped: unknown[]; ssgaNavHistory: Record<string, { splits: number; jumps: { date: string; sessionsBetween: number }[]; gaps: number }> };
      artifacts: string[];
    };
    // Each evaluated window, preceded by the 435 calendar days of warm-up the feature engine reads, counted from the
    // session before its first day (a decision before that close is computed on it); never the holdout's middle.
    expect(report.windows).toEqual([
      { segment: "design", from: "2006-03-22", to: "2018-12-31", evaluatedFrom: "2007-06-01" },
      { segment: "recent", from: "2023-10-23", to: "2026-09-06", evaluatedFrom: "2025-01-01" },
    ]);
    const keyed = Object.fromEntries(file.actions.map((e) => [`${String(e.action["entityId"] ?? e.action["parent"])} ${String(e.action["kind"])} ${String(e.action["exDate"])}`, e.sources]));
    expect(keyed).toEqual({
      "BIL CASH_DIVIDEND 2008-02-01": ["issuer:ssga-distributions", "vendor:tiingo-eod"],
      "BIL CASH_DIVIDEND 2008-03-03": ["issuer:ssga-distributions", "vendor:tiingo-eod"],
      "IWM CASH_DIVIDEND 2018-12-17": ["issuer:ishares-distributions", "vendor:tiingo-eod"],
      "QQQ CASH_DIVIDEND 2018-12-24": ["issuer:invesco-notice", "vendor:tiingo-eod"],
      "SPY CASH_DIVIDEND 2018-12-21": ["issuer:ssga-distributions", "vendor:tiingo-eod"],
      "VTI CASH_DIVIDEND 2010-03-24": ["issuer:vanguard-annual-report", "vendor:tiingo-eod"],
      "VTI CASH_DIVIDEND 2010-06-24": ["vendor:tiingo-eod"],
      "VTI CASH_DIVIDEND 2018-12-24": ["issuer:vanguard-distributions", "vendor:tiingo-eod"],
      "XLF CASH_DIVIDEND 2016-09-16": ["issuer:ssga-distributions", "vendor:tiingo-eod"],
      "XLF SPINOFF 2016-09-19": ["issuer:ssga-notice", "exchange:nyse-arca-notice"],
      "XLK CASH_DIVIDEND 2018-09-24": ["issuer:ssga-distributions", "vendor:tiingo-eod"],
      "XLK CASH_DIVIDEND 2018-12-24": ["issuer:ssga-distributions", "vendor:tiingo-eod"],
      // The NAV history's 2017 reverse split has no vendor row: written single-sourced, flagged, but not the owner's to curate.
      "XLK SPLIT 2017-12-01": ["issuer:ssga-nav-history"],
      "XLK SPLIT 2025-12-02": ["issuer:ssga-nav-history", "vendor:tiingo-eod"],
    });
    // VTI 2020-06-25 sits between the windows: no decision reads it, so it is neither written nor reported.
    expect(Object.keys(keyed).some((k) => k.includes("2020"))).toBe(false);
    expect(report.toCurate).toEqual([{ entityId: "VTI", kind: "CASH_DIVIDEND", exDate: "2010-06-24", vendorValue: "0.51" }]);
    expect(summary.toCurate).toBe(1);
    // The revised Tiingo dividend is read at its newest value (it agrees with Vanguard above) and named in the report.
    expect(report.vendor.revisedActions).toEqual(["tiingo/corporate-actions/VTI/CASH_DIVIDEND/2018-12-24"]);
    // Every in-scope Tiingo row, before the windows: 2020-06-25 is read and then left out by the reconciler.
    expect(report.vendor.records).toBe(14);
    expect(report.issuer.ssgaFunds).toEqual(["BIL", "SPY", "XLF", "XLK"]);
    expect(report.issuer.ssgaPayDateDropped).toEqual([{ entityId: "BIL", exDate: "2008-03-03", payDate: "2008-02-11" }]);
    // The NAV history's jumps and gaps reach the report, counted on the exchange calendar: 2006-05-26 to 05-30
    // spans a weekend and Memorial Day, so no session is missing between them.
    const xlk = report.issuer.ssgaNavHistory["XLK"];
    expect(xlk?.splits).toBe(2);
    expect(xlk?.jumps.map((j) => `${j.date}:${j.sessionsBetween}`)).toEqual(["2006-05-30:0", "2007-01-05:0", "2008-10-10:0"]);
    expect(xlk?.gaps).toBe(4);

    // Unsigned: ingest refuses it until the owner signs.
    expect(file.approval).toMatchObject({ approvedBy: null, approvedAt: null, actionsHash: summary.actionsHash });
    const unsigned = new Uint8Array(readFileSync(summary.out));
    expect(() => parseCorporateActions(unsigned, { calendar, ingestedAt: utc("2026-12-02T00:00:00Z"), rawContentHash: `sha256:${sha256Hex(unsigned)}` })).toThrow(UnapprovedCorporateActionsError);
    const signedBytes = new TextEncoder().encode(JSON.stringify({ ...file, approval: { ...file.approval, approvedBy: "Test Owner", approvedAt: "2026-12-01T00:00:00Z" } }));
    const obs = parseCorporateActions(signedBytes, { calendar, ingestedAt: utc("2026-12-02T00:00:00Z"), rawContentHash: `sha256:${sha256Hex(signedBytes)}` });
    const flagged = obs.filter((o) => o.qualityFlags.includes(UNVERIFIED_SINGLE_SOURCE)).map((o) => `${o.entityId} ${corporateActionFromValue(o.value).kind}`);
    expect(flagged.sort()).toEqual(["VTI CASH_DIVIDEND", "XLK SPLIT"]);

    // Nothing reached the point-in-time store; one ledger event records the run, and every input is an artifact.
    expect(observationCount(h.db)).toBe(before);
    const events = new Ledger(h.db).events().filter((e) => e.kind === "corporate_actions.reconciled");
    expect(events).toHaveLength(1);
    // 4 owner files + the distribution workbook + 4 NAV histories.
    expect(report.artifacts).toHaveLength(9);
    expect(h.requests).toEqual([SSGA_DISTRIBUTIONS_URL, ...["BIL", "SPY", "XLF", "XLK"].map(ssgaNavHistoryUrl)]);
  });

  it("never overwrites an output, and refuses before touching the network", async () => {
    const h = harness();
    const r = request(h);
    writeFileSync(r.report, "{}");
    await expect(runReconcile({ db: h.db, config: h.config, calendar, clock, fetchImpl: h.fetchImpl }, r)).rejects.toThrow(/already exists/);
    expect(h.requests).toEqual([]);
    expect(existsSync(r.out)).toBe(false);
  });

  it("refuses a store with no Tiingo actions: the evaluation store must never be its input", async () => {
    const h = harness({ seed: false });
    await expect(runReconcile({ db: h.db, config: h.config, calendar, clock, fetchImpl: h.fetchImpl }, request(h))).rejects.toThrow(/research store/);
    expect(h.requests).toEqual([]);
  });

  it("refuses an owner file for a fund outside the charter, or an iShares fund it cannot name", async () => {
    const h = harness();
    const deps = { db: h.db, config: h.config, calendar, clock, fetchImpl: h.fetchImpl };
    await expect(runReconcile(deps, request(h, { vanguard: [{ entityId: "VOO", file: h.files["vanguardVti"] ?? "" }] }))).rejects.toThrow(/VOO, which is not in the charter's scope/);
    await expect(runReconcile(deps, request(h, { ishares: [{ entityId: "XLK", file: h.files["isharesIwm"] ?? "" }] }))).rejects.toThrow(/no known iShares fund name for XLK/);
    expect(h.requests).toEqual([]);
  });
});

describe("parseReconcileArgs", () => {
  it("reads the paths and the TICKER=file pairs", () => {
    expect(parseReconcileArgs(["corporate-actions", "--charter", "c.yaml", "--out", "o.json", "--report", "r.json", "--vanguard", "vti=a.json, VTV=b.json", "--ishares", "IWM=i.xls", "--curated", "c.csv"])).toEqual({
      charter: "c.yaml",
      out: "o.json",
      report: "r.json",
      vanguard: [
        { entityId: "VTI", file: "a.json" },
        { entityId: "VTV", file: "b.json" },
      ],
      ishares: [{ entityId: "IWM", file: "i.xls" }],
      curated: "c.csv",
      structural: undefined,
      dataset: undefined,
    });
  });

  it("refuses a missing path, a malformed pair, an unknown flag, or another subcommand", () => {
    expect(() => parseReconcileArgs(["corporate-actions", "--charter", "c.yaml", "--out", "o.json"])).toThrow(/requires --report/);
    expect(() => parseReconcileArgs(["corporate-actions", "--charter", "c", "--out", "o", "--report", "r", "--vanguard", "VTI"])).toThrow(/TICKER=<file>/);
    expect(() => parseReconcileArgs(["corporate-actions", "--charter", "c", "--out", "o", "--report", "r", "--force"])).toThrow(UsageError);
    expect(() => parseReconcileArgs(["bars"])).toThrow(/subcommand corporate-actions/);
  });
});
