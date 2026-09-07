import { describe, expect, it } from "vitest";
import { addDays, isoDate, weekday } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { federalHolidays, isFederalBusinessDay, isFederalHoliday } from "../src/calendar/us-federal.ts";
import { cotReleaseInstant } from "../src/data/lag-rules.ts";

/**
 * The 2026 CFTC COT release schedule as published at
 * https://www.cftc.gov/MarketReports/CommitmentsofTraders/ReleaseSchedule/index.htm (fetched 2026-09-07,
 * docs/CAPABILITY_REGISTER.md CR-27). Asterisked dates are "Delayed release date due to a federal holiday."
 */
const PUBLISHED_2026: Record<string, string[]> = {
  "01": ["05*", "09", "16", "23", "30"],
  "02": ["06", "13", "20", "27"],
  "03": ["06", "13", "20", "27"],
  "04": ["03", "10", "17", "24"],
  "05": ["01", "08", "15", "22", "29"],
  "06": ["05", "12", "22*", "26"],
  "07": ["06*", "10", "17", "24", "31"],
  "08": ["07", "14", "21", "28"],
  "09": ["04", "11", "18", "25"],
  "10": ["02", "09", "16", "23", "30"],
  "11": ["06", "16*", "20", "30*"],
  "12": ["04", "11", "18", "28*"],
};

const published = Object.entries(PUBLISHED_2026)
  .flatMap(([mm, days]) => days.map((d) => ({ date: `2026-${mm}-${d.replace("*", "")}`, delayed: d.endsWith("*") })))
  .sort((a, b) => a.date.localeCompare(b.date));

describe("U.S. federal holiday calendar", () => {
  it("lists the eleven 2026 holidays with the federal observance shift", () => {
    expect(federalHolidays(2026)).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03", // Independence Day observed (July 4 is a Saturday)
      "2026-09-07",
      "2026-10-12",
      "2026-11-11",
      "2026-11-26",
      "2026-12-25",
    ]);
  });

  it("shifts Saturday holidays to Friday and Sunday holidays to Monday, and omits Juneteenth before 2021", () => {
    expect(isFederalHoliday(isoDate("2021-12-24"))).toBe(true); // Christmas 2021 was a Saturday
    expect(isFederalHoliday(isoDate("2022-12-26"))).toBe(true); // Christmas 2022 was a Sunday
    expect(isFederalHoliday(isoDate("2021-12-31"))).toBe(true); // New Year's Day 2022 was a Saturday
    expect(federalHolidays(2020).some((d) => d.endsWith("-06-19"))).toBe(false);
    expect(federalHolidays(2021)).toContain("2021-06-18"); // Juneteenth 2021 fell on a Saturday
  });

  it("differs from the NYSE calendar on Columbus Day and Veterans Day, which is why COT cannot use the exchange calendar", () => {
    const cal = new NyseCalendar();
    for (const d of ["2026-10-12", "2026-11-11"]) {
      expect(cal.isSession(isoDate(d)), d).toBe(true);
      expect(isFederalHoliday(isoDate(d)), d).toBe(true);
      expect(isFederalBusinessDay(isoDate(d)), d).toBe(false);
    }
    expect(isFederalBusinessDay(isoDate("2026-11-14"))).toBe(false); // Saturday
  });
});

describe("COT release rule against the published 2026 schedule", () => {
  it("reproduces all 52 release dates, including the six holiday-delayed Mondays", () => {
    const releases: { date: string; delayed: boolean }[] = [];
    let tuesday = isoDate("2025-12-30");
    for (let i = 0; i < 52; i++) {
      expect(weekday(tuesday)).toBe(2);
      const lag = cotReleaseInstant(tuesday);
      releases.push({ date: lag.availableAt.slice(0, 10), delayed: lag.flags.includes("RELEASE_DELAYED") });
      // Every instant is 15:30 New York time.
      expect(lag.availableAt.endsWith("T19:30:00.000Z") || lag.availableAt.endsWith("T20:30:00.000Z"), lag.availableAt).toBe(true);
      tuesday = addDays(tuesday, 7);
    }
    expect(releases).toEqual(published);
    expect(releases.filter((r) => r.delayed).map((r) => r.date)).toEqual(["2026-01-05", "2026-06-22", "2026-07-06", "2026-11-16", "2026-11-30", "2026-12-28"]);
  });

  it("a Monday federal holiday does not delay that week's Friday release", () => {
    for (const [tuesday, friday] of [
      ["2026-01-20", "2026-01-23"], // MLK Day Monday
      ["2026-02-17", "2026-02-20"], // Washington's Birthday
      ["2026-05-26", "2026-05-29"], // Memorial Day
      ["2026-09-08", "2026-09-11"], // Labor Day
      ["2026-10-13", "2026-10-16"], // Columbus Day (NYSE open, CFTC closed, release unaffected)
    ] as const) {
      const lag = cotReleaseInstant(isoDate(tuesday));
      expect(lag.availableAt.slice(0, 10), tuesday).toBe(friday);
      expect(lag.flags, tuesday).toEqual([]);
    }
  });

  it("Veterans Day on a Wednesday delays the release to Monday although the NYSE was open all week", () => {
    const lag = cotReleaseInstant(isoDate("2026-11-10"));
    expect(lag).toEqual({ availableAt: "2026-11-16T20:30:00.000Z", flags: ["RELEASE_DELAYED"] });
    // The exchange-calendar rule would have exposed the report on Friday 2026-11-13 15:30 ET, three days early.
    expect(new NyseCalendar().isSession(isoDate("2026-11-13"))).toBe(true);
  });

  it("a Tuesday federal holiday (no 2026 instance) is shifted the same way and marked estimated", () => {
    const lag = cotReleaseInstant(isoDate("2025-11-11")); // Veterans Day 2025 fell on the Tuesday
    expect(lag.availableAt.slice(0, 10)).toBe("2025-11-17");
    expect(lag.flags).toEqual(["RELEASE_DELAYED", "AVAILABLE_AT_ESTIMATED"]);
  });

  it("skips a holiday Monday when the delayed release itself lands on one", () => {
    // Christmas 2026 is a Friday; the delayed release is Monday 2026-12-28 (published). New Year's Day 2027 is a
    // Friday too, so the 2026-12-29 report releases Monday 2027-01-04.
    expect(cotReleaseInstant(isoDate("2026-12-29")).availableAt.slice(0, 10)).toBe("2027-01-04");
  });
});
