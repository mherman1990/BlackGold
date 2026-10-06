import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Dec, isoDate } from "@blackgold/shared";
import { SSGA_DISTRIBUTIONS_SOURCE } from "../src/data/adapters/ssga-distributions.ts";
import { CuratedInputError, parseCuratedActions, parseCuratedStructural } from "../src/data/curated-corporate-actions.ts";
import { reconcileCorporateActions } from "../src/data/corporate-actions-reconcile.ts";

/**
 * D-58: the owner's hand-curated rows, for what no issuer feed reaches. The property that matters is that a typed
 * row is read exactly or refused - never defaulted, and never able to pass for a fetched source.
 */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const HEADER = "source,entity,kind,ex_date,value,pay_date,document";
const csv = (...lines: string[]) => utf8([HEADER, ...lines].join("\n"));
const problemsOf = (bytes: Uint8Array): string[] => {
  try {
    parseCuratedActions(bytes, { file: "curated.csv" });
  } catch (err) {
    if (err instanceof CuratedInputError) return err.problems;
    throw err;
  }
  return [];
};

describe("parseCuratedActions", () => {
  it("reads cash and split rows, with quoted documents, CRLF, comments, blank and all-comma lines", () => {
    const bytes = utf8(
      [
        "﻿" + HEADER,
        "# VTI from Vanguard's annual reports",
        'issuer:vanguard-annual-report,vti,CASH_DIVIDEND,2010-03-24,0.4900,2010-03-29,"Annual report 2010, p. 14"',
        "",
        ",,,,,,",
        'issuer:vanguard-annual-report,VTI,SPLIT,2008-06-18,2,,"Prospectus supplement, ""share split"" notice"',
      ].join("\r\n"),
    );
    const recs = parseCuratedActions(bytes, { file: "curated.csv" });
    expect(recs).toEqual([
      { source: "issuer:vanguard-annual-report", kind: "CASH_DIVIDEND", entityId: "VTI", exDate: "2010-03-24", amount: new Dec("0.49"), payDate: "2010-03-29", locator: "curated.csv:3 Annual report 2010, p. 14" },
      { source: "issuer:vanguard-annual-report", kind: "SPLIT", entityId: "VTI", exDate: "2008-06-18", ratio: new Dec("2"), locator: 'curated.csv:6 Prospectus supplement, "share split" notice' },
    ]);
  });

  it("names every bad row at once, by line, and emits nothing", () => {
    const problems = problemsOf(
      csv(
        "vendor:tiingo-eod,VTI,CASH_DIVIDEND,2010-03-24,0.49,,doc",
        `${SSGA_DISTRIBUTIONS_SOURCE},XLK,CASH_DIVIDEND,2010-03-24,0.49,,doc`,
        "issuer:x,VTI,SPINOFF,2010-03-24,0.49,,doc",
        "issuer:x,VTI,CASH_DIVIDEND,03/24/2010,0.49,,doc",
        "issuer:x,VTI,CASH_DIVIDEND,2010-03-24,-0.49,,doc",
        "issuer:x,VTI,CASH_DIVIDEND,2010-03-24,1e-2,,doc",
        "issuer:x,VTI,CASH_DIVIDEND,2010-03-24,0.49,2010-03-20,doc",
        "issuer:x,VTI,SPLIT,2010-03-24,2,2010-03-30,doc",
        "issuer:x,VTI,CASH_DIVIDEND,2010-03-24,0.49,,",
        "issuer:x,VTI,CASH_DIVIDEND,2010-03-24,0.49",
        "issuer:x,1VTI,CASH_DIVIDEND,2010-03-24,0.49,,doc",
      ),
    );
    expect(problems).toEqual([
      expect.stringMatching(/^line 2: source "vendor:tiingo-eod" must look like issuer:<name> or exchange:<name>$/),
      expect.stringMatching(/^line 3: .* is an automated adapter's/),
      expect.stringMatching(/^line 4: kind "SPINOFF" must be CASH_DIVIDEND or SPLIT/),
      expect.stringMatching(/^line 5: ex_date "03\/24\/2010" is not a YYYY-MM-DD date$/),
      expect.stringMatching(/^line 6: value "-0.49" must be a positive decimal$/),
      expect.stringMatching(/^line 7: value "1e-2" must be a positive decimal$/),
      expect.stringMatching(/^line 8: pay_date 2010-03-20 precedes ex_date 2010-03-24$/),
      expect.stringMatching(/^line 9: a SPLIT has no pay_date$/),
      expect.stringMatching(/^line 10: document is required/),
      expect.stringMatching(/^line 11: 5 fields, expected 7$/),
      expect.stringMatching(/^line 12: entity "1VTI" is not a ticker$/),
    ]);
  });

  it("refuses a wrong header, an unclosed quote, and the same row twice", () => {
    expect(problemsOf(utf8("source,entity,kind,ex_date,amount,pay_date,document\n"))).toEqual([expect.stringMatching(/first row must be exactly/)]);
    expect(problemsOf(utf8(""))).toEqual([expect.stringMatching(/first row must be exactly/)]);
    expect(problemsOf(csv('issuer:x,VTI,CASH_DIVIDEND,2010-03-24,0.49,,"never closed'))).toEqual([expect.stringMatching(/never closed/)]);
    const row = "issuer:x,VTI,CASH_DIVIDEND,2010-03-24,0.49,,doc";
    expect(problemsOf(csv(row, row))).toEqual([expect.stringMatching(/^line 3: VTI CASH_DIVIDEND 2010-03-24 from issuer:x is already listed/)]);
  });

  it("feeds the reconciler as one more source, verified against the vendor", () => {
    const curated = parseCuratedActions(csv('issuer:vanguard-annual-report,VTI,CASH_DIVIDEND,2010-03-24,0.4900,2010-03-29,"AR 2010, p. 14"'), { file: "c.csv" });
    const vendor = { source: "vendor:tiingo-eod", kind: "CASH_DIVIDEND" as const, entityId: "VTI", exDate: isoDate("2010-03-24"), amount: new Dec("0.49"), locator: "tiingo" };
    const { file } = reconcileCorporateActions([...curated, vendor], {
      dataset: "d",
      window: { from: isoDate("2007-06-01"), to: isoDate("2018-12-31") },
      entities: ["VTI"],
      preferredSources: ["issuer:vanguard-distributions", "issuer:vanguard-annual-report"],
      amountTolerance: new Dec("0.0001"),
    });
    expect(file.actions).toEqual([
      { action: { kind: "CASH_DIVIDEND", entityId: "VTI", amount: "0.49", exDate: "2010-03-24", payDate: "2010-03-29", qualified: false }, sources: ["issuer:vanguard-annual-report", "vendor:tiingo-eod"] },
    ]);
  });
});

describe("the shipped examples", () => {
  const example = (name: string) => new Uint8Array(readFileSync(new URL(`../../../config/examples/${name}`, import.meta.url)));

  it("parse, so the documented format is the one the code reads", () => {
    expect(parseCuratedActions(example("curated-corporate-actions.example.csv"), { file: "example.csv" }).map((r) => `${r.entityId} ${r.exDate}`)).toEqual(["VTI 2010-03-24", "QQQ 2010-12-20"]);
    expect(parseCuratedStructural(example("curated-structural.example.json"), { file: "example.json" })).toEqual([
      {
        action: { kind: "SPINOFF", parent: "XLF", child: "XLRE", ratio: "0.139146", exDate: "2016-09-19", childFirstClose: "30.00" },
        sources: ["issuer:ssga-distribution-notice", "exchange:nyse-arca-notice"],
        supersedes: [
          { source: "issuer:ssga-distributions", kind: "CASH_DIVIDEND" },
          { source: "vendor:tiingo-eod", kind: "CASH_DIVIDEND" },
        ],
        keeps: [],
      },
    ]);
  });
});

describe("parseCuratedStructural", () => {
  const SPINOFF = { kind: "SPINOFF", parent: "XLF", child: "XLRE", ratio: "0.139146", exDate: "2016-09-19" };

  it("reads the vendored entry shape", () => {
    const entries = parseCuratedStructural(utf8(JSON.stringify({ actions: [{ action: SPINOFF, sources: ["issuer:ssga-notice", "exchange:nyse-arca"], announcedAt: "2016-08-31T20:00:00Z" }, { action: SPINOFF, sources: ["issuer:ssga-notice"] }] })), { file: "s.json" });
    expect(entries).toEqual([
      { action: SPINOFF, sources: ["issuer:ssga-notice", "exchange:nyse-arca"], announcedAt: "2016-08-31T20:00:00Z" },
      { action: SPINOFF, sources: ["issuer:ssga-notice"] },
    ]);
  });

  it("refuses bad JSON, unknown keys, no sources, a bad source name, or an announcement that is not an instant", () => {
    const bad = (o: unknown) => () => parseCuratedStructural(utf8(typeof o === "string" ? o : JSON.stringify(o)), { file: "s.json" });
    expect(bad("{")).toThrow(CuratedInputError);
    expect(bad({ actions: [{ action: SPINOFF, sources: ["issuer:a"], announced_at: "2016-08-31T20:00:00Z" }] })).toThrow(CuratedInputError);
    expect(bad({ actions: [{ action: SPINOFF, sources: [] }] })).toThrow(CuratedInputError);
    expect(bad({ actions: [{ action: SPINOFF, sources: ["SSGA press release"] }] })).toThrow(/issuer:<name>/);
    expect(bad({ actions: [{ action: SPINOFF, sources: ["issuer:a"], announcedAt: "2016-08-31" }] })).toThrow(/not a UTC instant/);
    // The same-day classification names a record by a real source and a reconciled kind.
    expect(bad({ actions: [{ action: SPINOFF, sources: ["issuer:a"], supersedes: [{ source: "SSGA", kind: "CASH_DIVIDEND" }] }] })).toThrow(/issuer:, exchange: or vendor:/);
    expect(bad({ actions: [{ action: SPINOFF, sources: ["issuer:a"], keeps: [{ source: "vendor:tiingo-eod", kind: "SPINOFF" }] }] })).toThrow(CuratedInputError);
  });
});
