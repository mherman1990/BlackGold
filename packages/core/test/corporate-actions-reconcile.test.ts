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
  preferredSources: [ISSUER],
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
    const r = run([cash(ISSUER, "XLK", "2018-06-18", "0.20"), cash(VENDOR, "XLK", "2018-06-18", "0.25")], { preferredSources: [VENDOR] });
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
  it("needs two sources, and at least one preferred source among them", () => {
    expect(() => run([cash(ISSUER, "VTI", "2018-03-22", "0.5")])).toThrow(ReconcileInputError);
    expect(() => run([cash(VENDOR, "VTI", "2018-03-22", "0.5"), cash("vendor:other", "VTI", "2018-03-22", "0.5")])).toThrow(/preferred sources/);
    expect(() => run([cash(ISSUER, "VTI", "2018-03-22", "0.5"), cash(VENDOR, "VTI", "2018-03-22", "0.5")], { preferredSources: [] })).toThrow(/at least one preferred source/);
  });

  it("refuses a source reporting the same distribution twice: components must be summed first", () => {
    expect(() => run([cash(ISSUER, "VTI", "2018-12-24", "0.70"), cash(ISSUER, "VTI", "2018-12-24", "0.05"), cash(VENDOR, "VTI", "2018-12-24", "0.75")])).toThrow(/twice/);
  });

  it("refuses a record the action parser rejects", () => {
    expect(() => run([cash(ISSUER, "VTI", "2018-12-24", "-0.10"), cash(VENDOR, "VTI", "2018-12-24", "0.75")])).toThrow(ReconcileInputError);
    expect(() => run([cash(ISSUER, "VTI", "2018-12-24", "0.75", { payDate: "2018-12-20" }), cash(VENDOR, "VTI", "2018-12-24", "0.75")])).toThrow(ReconcileInputError);
  });
});

describe("reconcileCorporateActions: several issuers (D-58)", () => {
  // Names chosen so that priority order and alphabetical order disagree.
  const CURATED = "issuer:zz-annual-report";
  const EXCHANGE = "exchange:aa-notices";

  it("carries the first preferred source that reports an action, in priority order, not alphabetical", () => {
    const r = run(
      [
        cash(ISSUER, "VTI", "2018-12-24", "0.75"),
        cash(CURATED, "VTI", "2018-12-24", "0.80"),
        cash(CURATED, "QQQ", "2010-12-20", "0.30"),
        cash(EXCHANGE, "QQQ", "2010-12-20", "0.33"),
      ],
      { preferredSources: [ISSUER, CURATED], entities: ["VTI", "QQQ"] },
    );
    expect(entryFor(r, "VTI", "2018-12-24")).toMatchObject({ sources: [ISSUER], action: { amount: "0.75" } });
    // ISSUER is silent on QQQ, so CURATED - second in priority, last alphabetically - carries it.
    expect(entryFor(r, "QQQ", "2010-12-20")).toMatchObject({ sources: [CURATED], action: { amount: "0.3" } });
    expect(r.report.preferredSources).toEqual([ISSUER, CURATED]);
  });

  it("verifies a curated record against the vendor like any other source", () => {
    const r = run([cash(CURATED, "VUG", "2012-03-23", "0.2100"), cash(VENDOR, "VUG", "2012-03-23", "0.21")], { preferredSources: [ISSUER, CURATED], entities: ["VUG"] });
    expect(entryFor(r, "VUG", "2012-03-23")?.sources).toEqual([CURATED, VENDOR]);
  });
});

describe("reconcileCorporateActions: owner-curated structural actions (D-58)", () => {
  const SSGA = "issuer:ssga-distributions";
  const SPINOFF = { kind: "SPINOFF", parent: "XLF", child: "XLRE", ratio: "0.139146", exDate: "2016-09-19", childFirstClose: "33.12" };
  // The curator's classification of the same-day records: both are the spin-off in a dividend column.
  const SUPERSEDES = [
    { source: SSGA, kind: "CASH_DIVIDEND" as const },
    { source: VENDOR, kind: "CASH_DIVIDEND" as const },
  ];
  const ENTRY = { action: SPINOFF, sources: ["issuer:ssga-press-release", "exchange:nyse-arca-notice"], announcedAt: "2016-08-31T20:00:00Z", supersedes: SUPERSEDES };
  const structural = [ENTRY];
  const xlf = [
    cash(SSGA, "XLF", "2016-09-16", "0.114386"),
    cash(VENDOR, "XLF", "2016-09-16", "0.1144"),
    // The spin-off as each source's dividend column shows it: SSGA writes the share ratio, the vendor a cash value.
    cash(SSGA, "XLF", "2016-09-19", "0.139146"),
    cash(VENDOR, "XLF", "2016-09-19", "4.61"),
  ];
  const opts = { preferredSources: [SSGA], entities: ["XLF"], structural };

  it("writes the structural action as given and sets aside the same-day records it supersedes", () => {
    const r = run(xlf, opts);
    expect(r.file.actions.map((e) => e.action["kind"])).toEqual(["CASH_DIVIDEND", "SPINOFF"]);
    // The classification is the curator's instruction to the reconciler, not part of the vendored entry.
    expect(r.file.actions[1]).toEqual({ action: SPINOFF, sources: ["issuer:ssga-press-release", "exchange:nyse-arca-notice"], announcedAt: "2016-08-31T20:00:00Z" });
    expect(entryFor(r, "XLF", "2016-09-16")?.sources).toEqual([SSGA, VENDOR]);
    expect(r.report.setAside).toEqual([
      {
        entityId: "XLF",
        exDate: "2016-09-19",
        structuralKind: "SPINOFF",
        records: [
          { source: SSGA, kind: "CASH_DIVIDEND", exDate: "2016-09-19", value: "0.139146", locator: `${SSGA}/XLF/2016-09-19` },
          { source: VENDOR, kind: "CASH_DIVIDEND", exDate: "2016-09-19", value: "4.61", locator: `${VENDOR}/XLF/2016-09-19` },
        ],
        kept: [],
      },
    ]);
    // Set aside, not one-sided or disputed: the structural action accounts for that date.
    expect(r.report.counts).toMatchObject({ actions: 2, verified: 2, structural: 1, setAside: 2, disagreements: 0, oneSided: 0 });
    // The structural action's publishers are sources of the file too, in the report and its per-entity counts.
    expect(r.report.sources).toEqual(["exchange:nyse-arca-notice", SSGA, "issuer:ssga-press-release", VENDOR]);
    expect(r.report.perEntity).toEqual([
      // Set-aside records still count as what their source reported (Codex, PR #114): two each, one per date.
      { entityId: "XLF", bySource: { "exchange:nyse-arca-notice": 1, [SSGA]: 2, "issuer:ssga-press-release": 1, [VENDOR]: 2 }, verified: 2, singleSource: 0 },
    ]);
    expect(r.file.notes).toContain(`exchange:nyse-arca-notice, ${SSGA}, issuer:ssga-press-release, ${VENDOR}`);
  });

  it("keeps a genuine same-day action the curator names, sets aside a superseded split, and leaves other dates alone", () => {
    const EXCH = "exchange:special-notice";
    const classified = [{ ...ENTRY, supersedes: [...SUPERSEDES, { source: VENDOR, kind: "SPLIT" as const }], keeps: [{ source: EXCH, kind: "CASH_DIVIDEND" as const }] }];
    const r = run([...xlf, split(VENDOR, "XLF", "2016-09-19", "2"), cash(EXCH, "XLF", "2016-09-19", "0.02"), cash(VENDOR, "XLF", "2016-09-20", "0.01")], { ...opts, structural: classified });
    expect(r.report.setAside[0]?.records.map((x) => `${x.source} ${x.kind}`)).toEqual([`${SSGA} CASH_DIVIDEND`, `${VENDOR} CASH_DIVIDEND`, `${VENDOR} SPLIT`]);
    // Kept: reconciled like any record - here one source, so written single-sourced - and listed for the audit.
    expect(r.report.setAside[0]?.kept).toEqual([{ source: EXCH, kind: "CASH_DIVIDEND", exDate: "2016-09-19", value: "0.02", locator: `${EXCH}/XLF/2016-09-19` }]);
    expect(entryFor(r, "XLF", "2016-09-19")).toMatchObject({ sources: [EXCH], action: { kind: "CASH_DIVIDEND", amount: "0.02" } });
    expect(entryFor(r, "XLF", "2016-09-20")?.sources).toEqual([VENDOR]);
  });

  it("refuses a same-day record the curator has not classified, or one classified both ways (Codex, PR #114)", () => {
    // Neither default is safe: setting it aside could drop a genuine dividend, writing it could count the spin-off twice.
    const BARE = { action: SPINOFF, sources: ["issuer:ssga-press-release", "exchange:nyse-arca-notice"] };
    const bare = [BARE];
    expect(() => run(xlf, { ...opts, structural: bare })).toThrow(/supersedes .* or keeps .*XLF 2016-09-19: issuer:ssga-distributions CASH_DIVIDEND 0.139146; XLF 2016-09-19: vendor:tiingo-eod CASH_DIVIDEND 4.61/);
    const partly = [{ ...BARE, supersedes: [{ source: SSGA, kind: "CASH_DIVIDEND" as const }] }];
    expect(() => run(xlf, { ...opts, structural: partly })).toThrow(/vendor:tiingo-eod CASH_DIVIDEND 4.61/);
    const both = [{ ...BARE, supersedes: SUPERSEDES, keeps: [{ source: VENDOR, kind: "CASH_DIVIDEND" as const }] }];
    expect(() => run(xlf, { ...opts, structural: both })).toThrow(/both supersedes and keeps vendor:tiingo-eod CASH_DIVIDEND/);
    // Two structural actions on one entity and day pool their lists, and must not contradict each other (Codex, PR #114).
    const delisting = { action: { kind: "DELISTING", entityId: "XLF", lastTradeDate: "2016-09-19", reason: "test", finalPrice: "0" }, sources: ["issuer:x"], keeps: [{ source: VENDOR, kind: "CASH_DIVIDEND" as const }] };
    expect(() => run(xlf, { ...opts, structural: [ENTRY, delisting] })).toThrow(/structural actions on XLF 2016-09-19 disagree: one supersedes and another keeps vendor:tiingo-eod CASH_DIVIDEND/);
    // Pooled lists that agree are fine: the second action adds nothing new, and both are written.
    const agreeing = { ...delisting, keeps: [] };
    expect(run(xlf, { ...opts, structural: [ENTRY, agreeing] }).report.setAside[0]?.structuralKind).toBe("DELISTING+SPINOFF");
  });

  it("ignores a structural action outside the window or universe, and then sets nothing aside", () => {
    for (const o of [{ ...opts, entities: ["VTI"] }, { ...opts, window: { from: D("2017-01-01"), to: D("2018-12-31") } }]) {
      const r = run([...xlf, cash(SSGA, "VTI", "2017-03-23", "0.5"), cash(VENDOR, "VTI", "2017-03-23", "0.5")], o);
      expect(r.file.actions.some((e) => e.action["kind"] === "SPINOFF")).toBe(false);
      expect(r.report.setAside).toEqual([]);
      // Not written, but never silent: the audit sees what was left out and why.
      expect(r.report.structuralOutOfScope).toEqual([
        { index: 0, kind: "SPINOFF", entityId: "XLF", exDate: "2016-09-19", reason: o.entities.includes("XLF") ? "outside the window" : "entity not in scope" },
      ]);
    }
    // A mis-cased entity is a typo for one in scope, not another entity: refused, not dropped (Codex, PR #114).
    expect(() => run(xlf, { ...opts, structural: [{ ...ENTRY, action: { ...SPINOFF, parent: "xlf" } }] })).toThrow(/structural\[0\] names xlf; the entity is XLF/);
    const inWindow = run([...xlf], { ...opts, structural: [] });
    expect(inWindow.report.disagreements.map((f) => f.exDate)).toEqual(["2016-09-19"]);
  });

  it("writes a single-sourced structural action, which ingest then flags", () => {
    const r = run(xlf, { ...opts, structural: [{ action: SPINOFF, sources: ["issuer:ssga-press-release"], supersedes: SUPERSEDES }] });
    expect(r.report.counts).toMatchObject({ verified: 1, singleSource: 1 });
    const signedFile = { ...r.file, approval: { ...r.file.approval, approvedBy: "Test Owner", approvedAt: "2026-10-06T00:00:00Z" } };
    const bytes = new TextEncoder().encode(JSON.stringify(signedFile));
    const obs = parseCorporateActions(bytes, { calendar: new NyseCalendar(), ingestedAt: utc("2026-12-01T00:00:00Z"), rawContentHash: `sha256:${sha256Hex(bytes)}` });
    const spin = obs.find((o) => corporateActionFromValue(o.value).kind === "SPINOFF");
    expect(spin?.qualityFlags).toEqual([UNVERIFIED_SINGLE_SOURCE]);
    // One source named twice is still one source, as ingest counts it.
    const twice = run(xlf, { ...opts, structural: [{ action: SPINOFF, sources: ["issuer:ssga-press-release", "issuer:ssga-press-release"], supersedes: SUPERSEDES }] });
    expect(twice.report.counts).toMatchObject({ verified: 1, singleSource: 1 });
  });

  it("refuses a structural entry that is not structural, is malformed, or is given twice", () => {
    const cashAction = { kind: "CASH_DIVIDEND", entityId: "XLF", amount: "0.1", exDate: "2016-09-19", payDate: "2016-09-22", qualified: false };
    expect(() => run(xlf, { ...opts, structural: [{ action: cashAction, sources: ["issuer:x"] }] })).toThrow(/only SPINOFF, MERGER and DELISTING/);
    expect(() => run(xlf, { ...opts, structural: [{ action: { ...SPINOFF, ratio: "0" }, sources: ["issuer:x"] }] })).toThrow(ReconcileInputError);
    expect(() => run(xlf, { ...opts, structural: [...structural, ...structural] })).toThrow(/given twice/);
    // A misspelled optional field would be written, signed and then silently not read (Codex, PR #114).
    const { childFirstClose, ...rest } = SPINOFF;
    expect(() => run(xlf, { ...opts, structural: [{ action: { ...rest, childFirstclose: childFirstClose }, sources: ["issuer:x"] }] })).toThrow(/a SPINOFF has no field childFirstclose/);
    // And one with no first close at all: verified by two sources, yet its value would never be credited.
    expect(() => run(xlf, { ...opts, structural: [{ action: rest, sources: ["issuer:x", "exchange:y"] }] })).toThrow(/needs childFirstClose/);
    // Nor one whose value the series cannot reach any other way: a merger paying stock (Codex, PR #114).
    const stockMerger = { action: { kind: "MERGER", entityId: "XLF", acquirer: "ACQ", terms: { stockRatio: "0.5" }, effective: "2016-09-19" }, sources: ["issuer:x", "exchange:y"] };
    expect(() => run(xlf, { ...opts, structural: [stockMerger] })).toThrow(/XLF MERGER pays stock/);
    const negativeDelisting = { action: { kind: "DELISTING", entityId: "XLF", lastTradeDate: "2016-09-19", reason: "x", finalPrice: "-1" }, sources: ["issuer:x", "exchange:y"] };
    expect(() => run(xlf, { ...opts, structural: [negativeDelisting] })).toThrow(/finalPrice must be non-negative/);
    // At most one terminal action per entity, across MERGER and DELISTING (Codex, PR #114).
    const delisted = (date: string) => ({ action: { kind: "DELISTING", entityId: "XLF", lastTradeDate: date, reason: "x", finalPrice: "1" }, sources: ["issuer:x", "exchange:y"] });
    const merged = { action: { kind: "MERGER", entityId: "XLF", acquirer: "ACQ", terms: { cashPerShare: "10" }, effective: "2017-03-01" }, sources: ["issuer:x", "exchange:y"] };
    expect(() => run(xlf, { ...opts, structural: [delisted("2017-01-03"), delisted("2017-06-01")] })).toThrow(/XLF has two terminal actions, DELISTING 2017-01-03 and DELISTING 2017-06-01/);
    expect(() => run(xlf, { ...opts, structural: [delisted("2017-01-03"), merged] })).toThrow(/XLF has two terminal actions/);
  });

  it("refuses a duplicate record even where it would be set aside (Codex, PR #114)", () => {
    expect(() => run([...xlf, cash(SSGA, "XLF", "2016-09-19", "0.139146")], opts)).toThrow(/issuer:ssga-distributions reports XLF\|CASH_DIVIDEND\|2016-09-19 twice/);
  });

  describe("a merger or delisting ends the series, which ignores anything dated after its last bar (Codex, PR #114)", () => {
    const SOURCES = ["issuer:x", "exchange:y"];
    // The target trades until 2016-09-16; the series stops there and realizes the cash on the effective date.
    const merger = (extra: object = {}) => ({ action: { kind: "MERGER", entityId: "XLF", acquirer: "ACQ", terms: { cashPerShare: "25" }, effective: "2016-09-19" }, sources: SOURCES, ...extra });
    const delisting = (extra: object = {}, lastTradeDate = "2016-09-20") => ({ action: { kind: "DELISTING", entityId: "XLF", lastTradeDate, reason: "liquidated", finalPrice: "24" }, sources: SOURCES, ...extra });
    const later = cash(VENDOR, "XLF", "2016-09-21", "0.40");

    it("refuses to keep a distribution on a merger's effective date: it would be verified and never applied", () => {
      expect(() => run(xlf, { ...opts, structural: [merger({ supersedes: [SUPERSEDES[0]], keeps: [SUPERSEDES[1]] })] })).toThrow(
        /cannot be kept: XLF 2016-09-19: vendor:tiingo-eod CASH_DIVIDEND 4.61 \(series ends with its MERGER 2016-09-19\)\. Fold a payout into the merger's terms\.cashPerShare/,
      );
      // Superseded - folded into the cash per share - it is set aside and reported.
      const r = run(xlf, { ...opts, structural: [merger({ supersedes: SUPERSEDES })] });
      expect(r.report.setAside[0]?.records.map((x) => `${x.source} ${x.exDate}`)).toEqual([`${SSGA} 2016-09-19`, `${VENDOR} 2016-09-19`]);
      expect(r.file.actions.map((e) => `${String(e.action["kind"])} ${String(e.action["exDate"] ?? e.action["effective"])}`)).toEqual(["CASH_DIVIDEND 2016-09-16", "MERGER 2016-09-19"]);
    });

    it("has the terminal action classify every record after the series end, and lets it only supersede them", () => {
      const before = xlf.slice(0, 2);
      // Unclassified: refused, like a same-day record.
      expect(() => run([...before, later], { ...opts, structural: [delisting()] })).toThrow(/past the merger or delisting that ends its entity's series, must be listed .*XLF 2016-09-21: vendor:tiingo-eod CASH_DIVIDEND 0.4/);
      expect(() => run([...before, later], { ...opts, structural: [delisting({ keeps: [{ source: VENDOR, kind: "CASH_DIVIDEND" }] })] })).toThrow(/cannot be kept: XLF 2016-09-21/);
      // Superseded: set aside under the delisting's date, with its own date for the audit.
      const r = run([...before, later], { ...opts, structural: [delisting({ supersedes: [{ source: VENDOR, kind: "CASH_DIVIDEND" }] })] });
      expect(r.report.setAside).toEqual([
        { entityId: "XLF", exDate: "2016-09-20", structuralKind: "DELISTING", records: [{ source: VENDOR, kind: "CASH_DIVIDEND", exDate: "2016-09-21", value: "0.4", locator: `${VENDOR}/XLF/2016-09-21` }], kept: [] },
      ]);
      expect(r.file.actions.map((e) => e.action["kind"])).toEqual(["CASH_DIVIDEND", "DELISTING"]);
      // The last trade date itself is inside the series: a genuine dividend there is kept and applied.
      const onLastDay = run(before, { ...opts, structural: [delisting({ keeps: [{ source: SSGA, kind: "CASH_DIVIDEND" }, { source: VENDOR, kind: "CASH_DIVIDEND" }] }, "2016-09-16")] });
      expect(entryFor(onLastDay, "XLF", "2016-09-16")?.sources).toEqual([SSGA, VENDOR]);
      // Other entities are untouched by XLF's end.
      expect(entryFor(run([...before, cash(SSGA, "VTI", "2016-09-21", "0.5"), cash(VENDOR, "VTI", "2016-09-21", "0.5")], { ...opts, entities: ["XLF", "VTI"], structural: [delisting()] }), "VTI", "2016-09-21")?.sources).toEqual([SSGA, VENDOR]);
    });

    it("refuses a spin-off after the series end, whatever the order the entries come in", () => {
      const spinAfter = { action: { ...SPINOFF, exDate: "2016-09-20" }, sources: SOURCES };
      expect(() => run(xlf.slice(0, 2), { ...opts, structural: [spinAfter, merger()] })).toThrow(/the XLF SPINOFF 2016-09-20 falls after XLF's series ends with its MERGER 2016-09-19/);
      expect(() => run(xlf.slice(0, 2), { ...opts, structural: [{ ...spinAfter, action: { ...SPINOFF, exDate: "2016-09-19" } }, merger()] })).toThrow(/SPINOFF 2016-09-19 falls after/);
      // On a delisting's last trade date the series still applies it.
      expect(run(xlf.slice(0, 2), { ...opts, structural: [{ ...spinAfter, action: { ...SPINOFF, exDate: "2016-09-16" } }, delisting({ keeps: SUPERSEDES }, "2016-09-16")] }).report.counts.structural).toBe(2);
    });
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
