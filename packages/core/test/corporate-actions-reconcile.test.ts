import { describe, expect, it } from "vitest";
import { Dec, isoDate, sha256Hex, utc, type IsoDate } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { UNVERIFIED_SINGLE_SOURCE, UnapprovedCorporateActionsError, corporateActionsHash, parseCorporateActions } from "../src/data/adapters/corporate-actions.ts";
import { parseTiingoCorporateActions } from "../src/data/adapters/tiingo-corporate-actions.ts";
import {
  DEFAULT_AMOUNT_TOLERANCE,
  ReconcileInputError,
  reconcileCorporateActions,
  sourceActionsFromObservations,
  type ReconcileOptions,
  type SourceAction,
} from "../src/data/corporate-actions-reconcile.ts";
import { corporateActionFromValue } from "../src/market/types.ts";

/**
 * D-57: machine reconciliation of corporate actions across independent sources. The property that matters most
 * is that NOTHING IS DROPPED - an action one source misses or misreports is still written, single-sourced and
 * reported, because leaving a dividend out would silently understate every return that spans it. The second is
 * that the output is exactly what ingest reads, unsigned until the owner signs it.
 */

const ISSUER = "issuer:test-distributions";
const VENDOR = "vendor:tiingo-eod";
const D = (s: string): IsoDate => isoDate(s);
const N = (s: string): Dec => new Dec(s);

const cash = (source: string, entityId: string, exDate: string, amount: string, extra: { payDate?: string; announcedAt?: string } = {}): SourceAction => ({
  source,
  entityId,
  kind: "CASH_DIVIDEND",
  exDate: D(exDate),
  amount: N(amount),
  locator: `${source}/${entityId}/${exDate}`,
  ...(extra.payDate === undefined ? {} : { payDate: D(extra.payDate) }),
  ...(extra.announcedAt === undefined ? {} : { announcedAt: utc(extra.announcedAt) }),
});
const split = (source: string, entityId: string, exDate: string, ratio: string): SourceAction => ({
  source,
  entityId,
  kind: "SPLIT",
  exDate: D(exDate),
  ratio: N(ratio),
  locator: `${source}/${entityId}/${exDate}`,
});

const OPTS: ReconcileOptions = {
  dataset: "etf-test",
  window: { from: D("2008-01-01"), to: D("2018-12-31") },
  entities: ["VTI", "XLK", "BIL"],
  preferredSource: ISSUER,
  amountTolerance: N(DEFAULT_AMOUNT_TOLERANCE),
};

const run = (records: SourceAction[], opts: Partial<ReconcileOptions> = {}) => reconcileCorporateActions(records, { ...OPTS, ...opts });
const entryFor = (r: ReturnType<typeof run>, entityId: string, exDate: string) =>
  r.file.actions.find((e) => e.action["entityId"] === entityId && e.action["exDate"] === exDate);

describe("reconcileCorporateActions: agreement", () => {
  it("names both sources when they agree within tolerance, and carries the issuer's values", () => {
    // The issuer quotes six places, the vendor four: 0.234213 vs 0.2342 differ by 0.000013, inside 0.0001.
    const r = run([
      cash(ISSUER, "XLK", "2018-03-19", "0.234213", { payDate: "2018-03-23", announcedAt: "2018-03-15T20:00:00Z" }),
      cash(VENDOR, "XLK", "2018-03-19", "0.2342"),
    ]);
    const e = entryFor(r, "XLK", "2018-03-19");
    expect(e?.sources).toEqual([ISSUER, VENDOR]);
    expect(e?.action).toMatchObject({ kind: "CASH_DIVIDEND", amount: "0.234213", payDate: "2018-03-23", qualified: false });
    expect(e?.announcedAt).toBe("2018-03-15T20:00:00.000Z");
    expect(r.report.counts).toMatchObject({ actions: 1, verified: 1, singleSource: 0, disagreements: 0, oneSided: 0 });
  });

  it("applies the tolerance at its boundary: exactly 0.0001 apart agrees, a hair more does not", () => {
    const at = run([cash(ISSUER, "VTI", "2018-06-20", "0.5000"), cash(VENDOR, "VTI", "2018-06-20", "0.5001")]);
    expect(entryFor(at, "VTI", "2018-06-20")?.sources).toEqual([ISSUER, VENDOR]);
    const over = run([cash(ISSUER, "VTI", "2018-06-20", "0.5000"), cash(VENDOR, "VTI", "2018-06-20", "0.50010001")]);
    expect(entryFor(over, "VTI", "2018-06-20")?.sources).toEqual([ISSUER]);
    expect(over.report.disagreements).toHaveLength(1);
  });

  it("requires split ratios to match exactly", () => {
    // VTI's 2-for-1 of June 2008, as both a matching and a mismatching pair.
    const same = run([split(ISSUER, "VTI", "2008-06-18", "2"), split(VENDOR, "VTI", "2008-06-18", "2.0")]);
    expect(entryFor(same, "VTI", "2008-06-18")?.sources).toEqual([ISSUER, VENDOR]);
    const off = run([split(ISSUER, "VTI", "2008-06-18", "2"), split(VENDOR, "VTI", "2008-06-18", "2.00001")]);
    expect(entryFor(off, "VTI", "2008-06-18")?.sources).toEqual([ISSUER]);
    expect(off.report.disagreements[0]?.values.map((v) => v.value)).toEqual(["2", "2.00001"]);
  });
});

describe("reconcileCorporateActions: nothing is dropped", () => {
  it("writes a disputed action single-sourced at the issuer's value, and reports both values", () => {
    const r = run([cash(ISSUER, "XLK", "2018-06-18", "0.20", { payDate: "2018-06-22" }), cash(VENDOR, "XLK", "2018-06-18", "0.25")]);
    expect(entryFor(r, "XLK", "2018-06-18")).toMatchObject({ sources: [ISSUER], action: { amount: "0.2", payDate: "2018-06-22" } });
    expect(r.report.disagreements).toEqual([
      expect.objectContaining({ entityId: "XLK", exDate: "2018-06-18", written: { source: ISSUER, value: "0.2" }, values: [expect.objectContaining({ source: ISSUER, value: "0.2" }), expect.objectContaining({ source: VENDOR, value: "0.25" })] }),
    ]);
  });

  it("with three sources, names the two that agree and still reports the third that does not", () => {
    const OTHER = "vendor:other-feed";
    const r = run([cash(ISSUER, "VTI", "2018-12-24", "0.7531"), cash(VENDOR, "VTI", "2018-12-24", "0.7531"), cash(OTHER, "VTI", "2018-12-24", "0.8")]);
    expect(entryFor(r, "VTI", "2018-12-24")?.sources).toEqual([ISSUER, VENDOR]);
    expect(r.report.counts).toMatchObject({ verified: 1, disagreements: 1 });
    expect(r.report.disagreements[0]?.values.map((v) => `${v.source}=${v.value}`)).toEqual([`${ISSUER}=0.7531`, `${OTHER}=0.8`, `${VENDOR}=0.7531`]);
  });

  it("writes the preferred source's value whatever its name sorts as", () => {
    // Prefer the vendor here: it sorts after the issuer, so a fall back to the first source alphabetically shows.
    const r = run([cash(ISSUER, "XLK", "2018-06-18", "0.20"), cash(VENDOR, "XLK", "2018-06-18", "0.25")], { preferredSource: VENDOR });
    expect(entryFor(r, "XLK", "2018-06-18")).toMatchObject({ sources: [VENDOR], action: { amount: "0.25" } });
    expect(r.report.disagreements[0]?.written).toEqual({ source: VENDOR, value: "0.25" });
  });

  it("writes an action only one source reports, from that source, and reports it", () => {
    const r = run([cash(ISSUER, "BIL", "2018-02-01", "0.08"), cash(VENDOR, "XLK", "2018-09-24", "0.21"), cash(ISSUER, "VTI", "2018-12-24", "0.75"), cash(VENDOR, "VTI", "2018-12-24", "0.75")]);
    expect(r.file.actions).toHaveLength(3);
    // Vendor-only: no pay date in the feed, so the ex-date, as the Tiingo adapter does.
    expect(entryFor(r, "XLK", "2018-09-24")).toMatchObject({ sources: [VENDOR], action: { payDate: "2018-09-24" } });
    expect(entryFor(r, "BIL", "2018-02-01")?.sources).toEqual([ISSUER]);
    expect(r.report.oneSided.map((f) => `${f.entityId} ${f.written.source}`)).toEqual(["BIL issuer:test-distributions", "XLK vendor:tiingo-eod"]);
    expect(r.report.counts).toMatchObject({ actions: 3, verified: 1, singleSource: 2, oneSided: 2 });
  });

  it("never reconciles across ex-dates, but reports the likely match on each side", () => {
    // The same distribution dated three days apart: two one-sided entries, each pointing at the other.
    const r = run([cash(ISSUER, "XLK", "2018-03-16", "0.23"), cash(VENDOR, "XLK", "2018-03-19", "0.23")]);
    expect(r.file.actions.map((e) => e.sources)).toEqual([[ISSUER], [VENDOR]]);
    expect(r.report.oneSided.map((f) => f.nearMatches)).toEqual([[{ source: VENDOR, exDate: "2018-03-19", value: "0.23" }], [{ source: ISSUER, exDate: "2018-03-16", value: "0.23" }]]);
    // Outside the near-match window, no hint.
    const far = run([cash(ISSUER, "XLK", "2018-03-16", "0.23"), cash(VENDOR, "XLK", "2018-03-26", "0.23")]);
    expect(far.report.oneSided.every((f) => f.nearMatches.length === 0)).toBe(true);
  });

  it("writes exactly one entry per entity, kind and ex-date in scope", () => {
    const records = [
      cash(ISSUER, "VTI", "2017-03-23", "0.50"),
      cash(VENDOR, "VTI", "2017-03-23", "0.50"),
      cash(ISSUER, "VTI", "2017-06-22", "0.55"),
      cash(VENDOR, "VTI", "2017-09-21", "0.60"),
      split(ISSUER, "VTI", "2008-06-18", "2"),
      cash(VENDOR, "XLK", "2017-12-18", "0.30"),
      cash(ISSUER, "XLK", "2017-12-18", "0.40"),
    ];
    const r = run(records);
    const keys = new Set(records.map((x) => `${x.entityId}|${x.kind}|${x.exDate}`));
    expect(r.file.actions).toHaveLength(keys.size);
    expect(r.report.counts.verified + r.report.counts.singleSource).toBe(keys.size);
  });
});

describe("reconcileCorporateActions: scope", () => {
  it("ignores records outside the window or the universe on every side, rather than calling them one-sided", () => {
    // The vendor's history runs back to 2001 and covers SPY; neither is in scope, so neither is a finding.
    const r = run([cash(VENDOR, "VTI", "2005-03-24", "0.4"), cash(VENDOR, "SPY", "2018-03-16", "1.1"), cash(ISSUER, "VTI", "2018-03-22", "0.5"), cash(VENDOR, "VTI", "2018-03-22", "0.5")]);
    expect(r.file.actions).toHaveLength(1);
    expect(r.report.oneSided).toEqual([]);
  });

  it("shows a source that is silent for an entity in the per-entity counts", () => {
    const r = run([cash(VENDOR, "BIL", "2018-02-01", "0.08"), cash(VENDOR, "BIL", "2018-03-01", "0.09"), cash(ISSUER, "VTI", "2018-03-22", "0.5"), cash(VENDOR, "VTI", "2018-03-22", "0.5")]);
    const bil = r.report.perEntity.find((p) => p.entityId === "BIL");
    expect(bil).toEqual({ entityId: "BIL", bySource: { [ISSUER]: 0, [VENDOR]: 2 }, verified: 0, singleSource: 2 });
  });
});

describe("reconcileCorporateActions: the output is exactly what ingest reads, and it is unsigned", () => {
  const calendar = new NyseCalendar();
  const ingestedAt = utc("2026-12-01T00:00:00Z");
  const records = [
    cash(ISSUER, "VTI", "2018-12-24", "0.7531", { payDate: "2018-12-27" }),
    cash(VENDOR, "VTI", "2018-12-24", "0.7531"),
    cash(ISSUER, "XLK", "2018-12-24", "0.25"),
    split(ISSUER, "VTI", "2008-06-18", "2"),
    split(VENDOR, "VTI", "2008-06-18", "2"),
  ];

  it("leaves the signature empty, binds actionsHash to the actions, and is refused until signed", () => {
    const { file } = run(records);
    expect(file.approval).toEqual({ approvedBy: null, approvedAt: null, actionsHash: corporateActionsHash(file.actions) });
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    expect(() => parseCorporateActions(bytes, { calendar, ingestedAt, rawContentHash: `sha256:${sha256Hex(bytes)}` })).toThrow(UnapprovedCorporateActionsError);
  });

  it("once signed, ingests with the flag only on the actions a single source supports", () => {
    const { file } = run(records);
    const signedFile = { ...file, approval: { ...file.approval, approvedBy: "Test Owner", approvedAt: "2026-10-06T00:00:00Z" } };
    const bytes = new TextEncoder().encode(JSON.stringify(signedFile));
    const obs = parseCorporateActions(bytes, { calendar, ingestedAt, rawContentHash: `sha256:${sha256Hex(bytes)}` });
    expect(obs).toHaveLength(3);
    const flags = Object.fromEntries(obs.map((o) => [`${o.entityId}|${corporateActionFromValue(o.value).kind}`, o.qualityFlags]));
    expect(flags).toEqual({ "VTI|CASH_DIVIDEND": [], "VTI|SPLIT": [], "XLK|CASH_DIVIDEND": [UNVERIFIED_SINGLE_SOURCE] });
  });

  it("is deterministic: the same records in any order give the same file", () => {
    expect(JSON.stringify(run([...records].reverse()).file)).toBe(JSON.stringify(run(records).file));
  });
});

describe("reconcileCorporateActions: input it refuses rather than guess past", () => {
  it("needs two sources, and the preferred one among them", () => {
    expect(() => run([cash(ISSUER, "VTI", "2018-03-22", "0.5")])).toThrow(ReconcileInputError);
    expect(() => run([cash(VENDOR, "VTI", "2018-03-22", "0.5"), cash("vendor:other", "VTI", "2018-03-22", "0.5")])).toThrow(/preferred source/);
  });

  it("refuses a source reporting the same distribution twice: components must be summed first", () => {
    expect(() => run([cash(ISSUER, "VTI", "2018-12-24", "0.70"), cash(ISSUER, "VTI", "2018-12-24", "0.05"), cash(VENDOR, "VTI", "2018-12-24", "0.75")])).toThrow(/twice/);
  });

  it("refuses a record the action parser rejects", () => {
    expect(() => run([cash(ISSUER, "VTI", "2018-12-24", "-0.10"), cash(VENDOR, "VTI", "2018-12-24", "0.75")])).toThrow(ReconcileInputError);
    expect(() => run([cash(ISSUER, "VTI", "2018-12-24", "0.75", { payDate: "2018-12-20" }), cash(VENDOR, "VTI", "2018-12-24", "0.75")])).toThrow(ReconcileInputError);
  });
});

describe("sourceActionsFromObservations", () => {
  it("turns Tiingo corporate-action observations into vendor records, cash and splits", () => {
    const rows = [
      { date: "2008-06-18T00:00:00.000Z", divCash: 0, splitFactor: 2 },
      { date: "2018-12-24T00:00:00.000Z", divCash: 0.7531, splitFactor: 1 },
      { date: "2018-12-26T00:00:00.000Z", divCash: 0, splitFactor: 1 },
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(rows));
    const obs = parseTiingoCorporateActions(bytes, { calendar: new NyseCalendar(), ingestedAt: utc("2026-12-01T00:00:00Z"), rawContentHash: `sha256:${sha256Hex(bytes)}`, symbol: "VTI" });
    const recs = sourceActionsFromObservations(obs, VENDOR);
    expect(recs.map((x) => [x.source, x.entityId, x.kind, x.exDate, x.kind === "CASH_DIVIDEND" ? x.amount.toFixed() : x.ratio.toFixed()])).toEqual([
      [VENDOR, "VTI", "SPLIT", "2008-06-18", "2"],
      [VENDOR, "VTI", "CASH_DIVIDEND", "2018-12-24", "0.7531"],
    ]);
    expect(recs[0]?.locator).toBe("tiingo/corporate-actions/VTI/SPLIT/2008-06-18");
  });
});
