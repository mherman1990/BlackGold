import { describe, expect, it } from "vitest";
import { addDays, isoDate, utc, weekday } from "@blackgold/shared";
import { NyseCalendar } from "../src/index.ts";

/** Verified against https://www.nyse.com/markets/hours-calendars on 2026-09-06. */
const FIXTURES = {
  2026: {
    holidays: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
    earlyCloses: ["2026-11-27", "2026-12-24"],
  },
  2027: {
    holidays: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
    earlyCloses: ["2027-11-26"],
  },
} as const;

const cal = new NyseCalendar();

describe("NyseCalendar reproduces the published schedule exactly", () => {
  for (const [year, fx] of Object.entries(FIXTURES)) {
    it(`${year}: rule engine equals the fixture in both directions`, () => {
      const s = cal.schedule(Number(year));
      expect(s.holidays).toEqual(fx.holidays);
      expect(s.earlyCloses).toEqual(fx.earlyCloses);
      // Every weekday not in the fixture is a session; every fixture date is not.
      let d = isoDate(`${year}-01-01`);
      const end = isoDate(`${year}-12-31`);
      for (; d <= end; d = addDays(d, 1)) {
        const wd = weekday(d);
        const isWeekend = wd === 0 || wd === 6;
        const expected = !isWeekend && !(fx.holidays as readonly string[]).includes(d);
        expect(cal.isSession(d), d).toBe(expected);
        expect(cal.isEarlyClose(d), d).toBe((fx.earlyCloses as readonly string[]).includes(d));
      }
    });
  }

  it("session times respect DST and early closes", () => {
    expect(cal.sessionClose(isoDate("2026-03-06"))).toBe("2026-03-06T21:00:00.000Z"); // EST
    expect(cal.sessionClose(isoDate("2026-03-09"))).toBe("2026-03-09T20:00:00.000Z"); // EDT
    expect(cal.sessionOpen(isoDate("2026-03-09"))).toBe("2026-03-09T13:30:00.000Z");
    expect(cal.sessionClose(isoDate("2026-11-27"))).toBe("2026-11-27T18:00:00.000Z"); // 13:00 EST early close
    expect(cal.sessionClose(isoDate("2026-12-24"))).toBe("2026-12-24T18:00:00.000Z");
  });

  it("nextSession and previousSession step over weekends and holidays", () => {
    // Friday 2026-07-03 is a holiday; after Thursday's close the next session is Monday 07-06.
    expect(cal.nextSession(utc("2026-07-02T21:00:00Z"))).toBe("2026-07-06");
    // Mid-session: the next session whose open is after the instant is the following day.
    expect(cal.nextSession(utc("2026-07-01T15:00:00Z"))).toBe("2026-07-02");
    expect(cal.previousSession(utc("2026-07-06T12:00:00Z"))).toBe("2026-07-02");
    expect(cal.sessionDates(isoDate("2026-11-25"), isoDate("2026-11-30"))).toEqual(["2026-11-25", "2026-11-27", "2026-11-30"]);
  });

  it("refuses session times on non-sessions and years outside its range", () => {
    expect(() => cal.sessionOpen(isoDate("2026-07-03"))).toThrow();
    expect(() => cal.sessionOpen(isoDate("2026-07-04"))).toThrow();
    expect(() => cal.schedule(1990)).toThrow(RangeError);
  });

  it("ad hoc closures remove a session", () => {
    const withClosure = new NyseCalendar({ adHocClosures: [isoDate("2026-09-09")] });
    expect(withClosure.isSession(isoDate("2026-09-09"))).toBe(false);
    expect(cal.isSession(isoDate("2026-09-09"))).toBe(true);
  });

  it("treats the known historical closures as non-sessions by default", () => {
    // National days of mourning and disasters that no rule derives - all weekdays that would otherwise be sessions.
    for (const d of ["2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14", "2004-06-11", "2007-01-02", "2012-10-29", "2012-10-30", "2018-12-05", "2025-01-09"]) {
      expect(weekday(isoDate(d)), `${d} is a weekday`).not.toBe(0);
      expect(weekday(isoDate(d)), `${d} is a weekday`).not.toBe(6);
      expect(cal.isSession(isoDate(d)), d).toBe(false);
      expect(cal.isHoliday(isoDate(d)), d).toBe(true);
    }
    // Hurricane Sandy: the two closed days drop out of the session list.
    expect(cal.sessionDates(isoDate("2012-10-26"), isoDate("2012-10-31"))).toEqual(["2012-10-26", "2012-10-31"]);
    // schedule() stays rule-derived: it never lists an ad-hoc closure among the year's holidays.
    expect(cal.schedule(2012).holidays).not.toContain("2012-10-29");
  });

  it("can opt out of the baked-in closures for isolated tests", () => {
    const pure = new NyseCalendar({ includeDefaultAdHocClosures: false });
    expect(pure.isSession(isoDate("2012-10-29"))).toBe(true); // a plain Monday when the rule engine ignores Sandy
    expect(cal.isSession(isoDate("2012-10-29"))).toBe(false);
  });
});
