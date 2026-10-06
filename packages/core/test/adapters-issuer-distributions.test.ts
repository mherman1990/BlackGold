import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SchemaDriftError } from "../src/data/adapters/common.ts";
import { dayMonthYearDate, monthDayYearDate, plainIsoDate, usSlashDate } from "../src/data/adapters/issuer-dates.ts";
import { ISHARES_DISTRIBUTIONS_SOURCE, parseIsharesDistributions } from "../src/data/adapters/ishares-distributions.ts";
import { parseSsgaDistributions, SSGA_DISTRIBUTIONS_SOURCE, SSGA_NAV_HISTORY_SOURCE, ssgaNavSplits } from "../src/data/adapters/ssga-distributions.ts";
import { parseVanguardDistributions, VANGUARD_DISTRIBUTIONS_SOURCE } from "../src/data/adapters/vanguard-distributions.ts";
import type { SourceAction } from "../src/data/corporate-actions-reconcile.ts";

/**
 * D-58's issuer inputs. All fixtures are synthetic (test/fixtures/ssga/generate-distributions.py and the inline
 * strings below) in the layouts the live files had on 2026-10-06; the live files themselves are not reproduced.
 */
const FIX = new URL("../../../test/fixtures/ssga/", import.meta.url);
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, FIX)));
const brief = (rs: SourceAction[]) => rs.map((r) => [r.entityId, r.exDate, r.kind === "CASH_DIVIDEND" ? r.amount.toFixed() : r.ratio.toFixed()]);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("issuer date spellings", () => {
  it("reads each format exactly, and refuses impossible dates and other spellings", () => {
    expect(usSlashDate("03/03/2008")).toBe("2008-03-03");
    expect(usSlashDate(" 3/3/2008 ")).toBe("2008-03-03");
    expect(usSlashDate("02/30/2008")).toBeUndefined();
    expect(usSlashDate("2008-03-03")).toBeUndefined();
    expect(dayMonthYearDate("05-Dec-2025")).toBe("2025-12-05");
    expect(dayMonthYearDate("31-Jun-2025")).toBeUndefined();
    expect(dayMonthYearDate("05-Foo-2025")).toBeUndefined();
    expect(monthDayYearDate("Sep 15, 2026")).toBe("2026-09-15");
    expect(monthDayYearDate("Sep 15 2026")).toBeUndefined();
    expect(plainIsoDate("2016-12-20")).toBe("2016-12-20");
    expect(plainIsoDate("2016-13-20")).toBeUndefined();
  });
});

describe("parseSsgaDistributions", () => {
  const entities = ["XLK", "XLF", "BIL", "SPY"];

  it("emits one record per fund and ex-date, summing dividend and capital gains, for the funds asked for only", async () => {
    const d = await parseSsgaDistributions(fixture("distributions.xlsx"), { entities, locator: "sha256:abc" });
    expect(brief(d.records)).toEqual([
      ["XLK", "2018-12-24", "0.234213"],
      ["XLK", "2018-09-24", "0.1981"],
      ["XLF", "2016-09-19", "0.139146"],
      ["XLF", "2016-09-16", "0.114386"],
      // 1.4351 + 0.01 + 0.0025, in decimal.
      ["SPY", "2018-12-21", "1.4476"],
      ["BIL", "2008-03-03", "0.086739"],
      ["BIL", "2008-02-01", "0.115251"],
    ]);
    expect(d.records.every((r) => r.source === SSGA_DISTRIBUTIONS_SOURCE)).toBe(true);
    expect(d.records[0]).toMatchObject({ payDate: "2018-12-31", locator: "sha256:abc#XLK/2018-12-24" });
    // The SPY row pays in the next year: kept as given.
    expect(d.records.find((r) => r.entityId === "SPY")).toMatchObject({ payDate: "2019-01-31" });
  });

  it("counts zero rows instead of emitting them, and drops - and reports - a pay date before its ex-date", async () => {
    const d = await parseSsgaDistributions(fixture("distributions.xlsx"), { entities, locator: "x" });
    expect(d.zeroRows).toEqual([
      { entityId: "XLK", exDate: "2007-03-16" },
      { entityId: "BIL", exDate: "2009-12-01" },
    ]);
    expect(d.payDateDropped).toEqual([{ entityId: "BIL", exDate: "2008-03-03", payDate: "2008-02-11" }]);
    const bil = d.records.find((r) => r.exDate === "2008-03-03");
    expect(bil?.kind === "CASH_DIVIDEND" ? bil.payDate : "split").toBeUndefined();
  });

  it("does not read other funds' rows, so a defect there cannot block these - but does once asked for", async () => {
    await expect(parseSsgaDistributions(fixture("distributions.xlsx"), { entities: ["XLK"], locator: "x" })).resolves.toBeDefined();
    await expect(parseSsgaDistributions(fixture("distributions.xlsx"), { entities: ["XLK", "ZZZ"], locator: "x" })).rejects.toThrow(/ZZZ row \d+ has an unreadable ex-date/);
  });

  it("fails closed on a missing header, an unreadable date, a negative amount, a repeated ex-date, or not-a-workbook", async () => {
    const opts = { entities: ["XLK"], locator: "x" };
    await expect(parseSsgaDistributions(fixture("distributions-noheader.xlsx"), opts)).rejects.toThrow(/no header row/);
    await expect(parseSsgaDistributions(fixture("distributions-baddate.xlsx"), opts)).rejects.toThrow(/unreadable ex-date/);
    await expect(parseSsgaDistributions(fixture("distributions-negative.xlsx"), opts)).rejects.toThrow(/negative/);
    await expect(parseSsgaDistributions(fixture("distributions-dup.xlsx"), opts)).rejects.toThrow(/listed twice/);
    await expect(parseSsgaDistributions(utf8("not a workbook"), opts)).rejects.toBeInstanceOf(SchemaDriftError);
  });
});

describe("ssgaNavSplits", () => {
  it("reads a split only where NAV and shares outstanding both move by the same standard ratio", async () => {
    const n = await ssgaNavSplits(fixture("navhist-xlk.xlsx"), { etf: "xlk", locator: "nav" });
    expect(brief(n.records)).toEqual([
      ["XLK", "2017-12-01", "0.5"],
      ["XLK", "2025-12-02", "2"],
    ]);
    expect(n.records.every((r) => r.source === SSGA_NAV_HISTORY_SOURCE)).toBe(true);
    expect(n.records[1]?.locator).toBe("nav#XLK/2025-12-02");
    expect({ first: n.firstDate, last: n.lastDate, shares: n.sharesFirstDate }).toEqual({ first: "2006-05-25", last: "2025-12-03", shares: "2007-01-04" });
  });

  it("reports every other big one-day move as a jump and never turns it into a record", async () => {
    const n = await ssgaNavSplits(fixture("navhist-xlk.xlsx"), { etf: "XLK", locator: "nav" });
    expect(n.jumps).toEqual([
      // NAV halved with no published share count: no split can be confirmed.
      { previousDate: "2006-05-26", date: "2006-05-30", navRatio: "2.00344", sharesRatio: null },
      // NAV halved but shares rose 30%: no standard ratio fits both.
      { previousDate: "2007-01-04", date: "2007-01-05", navRatio: "2", sharesRatio: "1.302326" },
      // A 30% fall with shares flat: a market move, not a split, though 1.43 is within 15% of 1.5.
      { previousDate: "2008-10-09", date: "2008-10-10", navRatio: "1.428571", sharesRatio: "1" },
    ]);
  });

  it("refuses a file for another fund, one that names no fund, a repeated date, or an unreadable NAV", async () => {
    await expect(ssgaNavSplits(fixture("navhist-wrongfund.xlsx"), { etf: "XLK", locator: "x" })).rejects.toThrow(/for XLF, not XLK/);
    await expect(ssgaNavSplits(fixture("navhist-noticker.xlsx"), { etf: "XLK", locator: "x" })).rejects.toThrow(/does not name its fund/);
    await expect(ssgaNavSplits(fixture("navhist-dupdate.xlsx"), { etf: "XLK", locator: "x" })).rejects.toThrow(/listed twice/);
    await expect(ssgaNavSplits(fixture("navhist-badnav.xlsx"), { etf: "XLK", locator: "x" })).rejects.toThrow(/unreadable NAV/);
  });
});

describe("parseVanguardDistributions (an owner-downloaded file)", () => {
  const row = (exDividendDate: string, amount: number | string, typeCode = "INC", payableDate = exDividendDate) => ({ typeCode, amount, payableDate, exDividendDate, recordDate: exDividendDate, reinvestPrice: 375.82 });

  it("sums the components going ex on one date, reads JSON numbers as their published decimals, and sorts", () => {
    const v = parseVanguardDistributions(utf8(JSON.stringify([row("2018-12-24", 0.7531, "INC", "2018-12-27"), row("2017-12-22", 0.6409), row("2018-12-24", 0.0012, "STCG", "2018-12-27")])), { entityId: "vti", locator: "dl" });
    expect(brief(v.records)).toEqual([
      ["VTI", "2017-12-22", "0.6409"],
      ["VTI", "2018-12-24", "0.7543"],
    ]);
    expect(v.records[1]).toMatchObject({ source: VANGUARD_DISTRIBUTIONS_SOURCE, payDate: "2018-12-27", locator: "dl#VTI/2018-12-24" });
  });

  it("skips a zero total, and refuses a repeated component, mixed pay dates, a bad date, or a negative amount", () => {
    const parse = (rows: unknown[]) => () => parseVanguardDistributions(utf8(JSON.stringify(rows)), { entityId: "VTI", locator: "dl" });
    expect(parse([row("2018-12-24", 0), row("2017-12-22", 0.5)])()).toEqual({ records: [expect.objectContaining({ exDate: "2017-12-22" })], zeroDates: ["2018-12-24"] });
    expect(parse([row("2018-12-24", 0.5), row("2018-12-24", 0.5)])).toThrow(/INC twice/);
    expect(parse([row("2018-12-24", 0.5, "INC", "2018-12-27"), row("2018-12-24", 0.1, "LTCG", "2018-12-28")])).toThrow(/different payable dates/);
    expect(parse([row("12/24/2018", 0.5)])).toThrow(/unreadable exDividendDate/);
    expect(parse([row("2018-12-24", -0.5)])).toThrow(/negative/);
    expect(parse([row("2018-12-24", 0.5, "INC", "2018-12-20")])).toThrow(/before its ex-date/);
    expect(parse([])).toThrow(/no distributions/);
    expect(() => parseVanguardDistributions(utf8("<html>"), { entityId: "VTI", locator: "dl" })).toThrow(SchemaDriftError);
  });
});

describe("parseIsharesDistributions (an owner-downloaded file)", () => {
  const cell = (type: string, v: string) => `<ss:Cell ss:StyleID="Left">\n<ss:Data ss:Type="${type}">${v}</ss:Data>\n</ss:Cell>`;
  const xrow = (...cells: string[]) => `<ss:Row>\n${cells.join("\n")}\n</ss:Row>`;
  const dist = (ex: string, pay: string, total: string, income = total, roc = "0") =>
    xrow(cell("String", "Rec"), cell("String", ex), cell("String", pay), cell("Number", total), cell("Number", income), cell("Number", "0"), cell("Number", "0"), cell("Number", roc));
  const HEADER = xrow(...["Record Date", "Ex-Date", "Payable Date", "Total Distribution", "Income", "ST Cap Gains", "LT Cap Gains", "Return of Capital"].map((h) => cell("String", h)));
  // BlackRock leaves "&" unescaped (the "S&P" below), so the file is not well-formed XML.
  const workbook = (rows: string[], name = "iShares Russell 2000 ETF", distributionsSheet = true) =>
    utf8(
      `<?xml version="1.0"?>\n<ss:Workbook xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n<ss:Worksheet ss:Name="Holdings">\n<ss:Table>\n${xrow(cell("String", name))}\n${xrow(cell("String", "Index: Russell 2000 & S&P notes"))}\n</ss:Table>\n</ss:Worksheet>\n` +
        (distributionsSheet ? `<ss:Worksheet ss:Name="Distributions">\n<ss:Table>\n${[HEADER, ...rows].join("\n")}\n</ss:Table>\n</ss:Worksheet>\n` : "") +
        `</ss:Workbook>`,
    );
  const opts = { entityId: "iwm", fundName: "iShares Russell 2000 ETF", locator: "dl" };

  it("reads the Total Distribution column per ex-date - return of capital included - skips zeros, and sorts", () => {
    // 2007-12-27 paid 0.251439 of income and 0.015797 of return of capital: the series needs the total.
    const i = parseIsharesDistributions(workbook([dist("Sep 15, 2026", "Sep 18, 2026", "0.750436"), dist("Dec 27, 2007", "Jan 03, 2008", "0.267236", "0.251439", "0.015797"), dist("Mar 24, 2008", "Mar 28, 2008", "0")]), opts);
    expect(brief(i.records)).toEqual([
      ["IWM", "2007-12-27", "0.267236"],
      ["IWM", "2026-09-15", "0.750436"],
    ]);
    expect(i.records[0]).toMatchObject({ source: ISHARES_DISTRIBUTIONS_SOURCE, payDate: "2008-01-03", locator: "dl#IWM/2007-12-27" });
    expect(i.zeroDates).toEqual(["2008-03-24"]);
  });

  it("refuses a file for another fund, one without a Distributions sheet, or rows it cannot align", () => {
    expect(() => parseIsharesDistributions(workbook([dist("Sep 15, 2026", "Sep 18, 2026", "0.75")], "iShares Core S&P 500 ETF"), opts)).toThrow(/does not name iShares Russell 2000 ETF/);
    expect(() => parseIsharesDistributions(workbook([], undefined, false), opts)).toThrow(/no Distributions worksheet/);
    // A cell with nested markup would shift every later column onto the wrong header.
    const nested = xrow(cell("String", "Rec"), `<ss:Cell><ss:Data ss:Type="String"><B>Sep 15, 2026</B></ss:Data></ss:Cell>`, cell("String", "Sep 18, 2026"), cell("Number", "0.75"));
    expect(() => parseIsharesDistributions(workbook([nested]), opts)).toThrow(/cells but 3 readable values/);
    const skipping = xrow(cell("String", "Rec"), `<ss:Cell ss:Index="3"><ss:Data ss:Type="String">Sep 18, 2026</ss:Data></ss:Cell>`);
    expect(() => parseIsharesDistributions(workbook([skipping]), opts)).toThrow(/skips columns/);
  });

  it("refuses an unreadable date or amount, a repeated ex-date, or a pay date before the ex-date", () => {
    expect(() => parseIsharesDistributions(workbook([dist("2026-09-15", "Sep 18, 2026", "0.75")]), opts)).toThrow(/unreadable ex-date/);
    expect(() => parseIsharesDistributions(workbook([dist("Sep 15, 2026", "Sep 18, 2026", "--")]), opts)).toThrow(/unreadable total/);
    expect(() => parseIsharesDistributions(workbook([dist("Sep 15, 2026", "Sep 18, 2026", "0.7"), dist("Sep 15, 2026", "Sep 18, 2026", "0.7")]), opts)).toThrow(/listed twice/);
    expect(() => parseIsharesDistributions(workbook([dist("Sep 15, 2026", "Sep 10, 2026", "0.7")]), opts)).toThrow(/before its ex-date/);
    expect(() => parseIsharesDistributions(utf8("<html></html>"), opts)).toThrow(/not an iShares SpreadsheetML workbook/);
  });
});
