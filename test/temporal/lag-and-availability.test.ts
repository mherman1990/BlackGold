/**
 * Temporal fixtures from docs/DATA_PROVENANCE_SPEC.md section 11 that depend only on the point-in-time
 * repository, the exchange calendar, and the shared lag rules:
 *   future observation excluded, revision leakage sentinel, Form 4 acceptance vs transaction, COT release lag,
 *   13F lag, early close, DST transitions, corrected bar, temporal inversion rejection, artifact integrity.
 * Fixtures involving positions (split, dividend, delisting, symbol change) live in market-and-universe.test.ts.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, sha256Hex, utc, zonedToUtc, type UtcInstant } from "@blackgold/shared";
import {
  ArtifactStore,
  NyseCalendar,
  PointInTimeRepository,
  TemporalInversionError,
  cotReleaseInstant,
  dailyBarTimes,
  form4Deadline,
  form4Flags,
  openCoreDb,
  quarterEndOf,
  secDissemination,
  thirteenFDeadline,
  type PointInTimeObservation,
} from "@blackgold/core";

const cal = new NyseCalendar();
const T = (s: string): UtcInstant => utc(s);
const H = (s: string): string => `sha256:${sha256Hex(s)}`;

function rig(): { repo: PointInTimeRepository; store: ArtifactStore } {
  const dir = mkdtempSync(join(tmpdir(), "bg-temporal-"));
  const db = openCoreDb({ dbPath: join(dir, "t.sqlite") }).db;
  return { repo: new PointInTimeRepository(db), store: new ArtifactStore(join(dir, "artifacts"), db) };
}

function obs<T>(p: Partial<PointInTimeObservation<T>> & { sourceId: string; availableAt: UtcInstant; value: T }): PointInTimeObservation<T> {
  return {
    sourceLocator: p.sourceLocator ?? "loc",
    ingestedAt: T("2026-12-31T00:00:00Z"),
    rawContentHash: H(JSON.stringify(p.value)),
    adapterVersion: "1.0.0",
    parserVersion: "1.0.0",
    qualityFlags: [],
    ...p,
  };
}

describe("Fixture: future observation excluded", () => {
  it("one second past the cutoff is excluded; zero delay admits it and labels the run OPTIMISTIC_DELAY", () => {
    const { repo } = rig();
    const decisionAt = T("2026-09-08T20:00:00Z");
    const delay = 15 * 60_000; // sec.* default
    repo.append(obs({ sourceId: "sec.edgar.form4", availableAt: utc(Date.parse(decisionAt) - delay + 1000), value: { late: true } }));
    repo.append(obs({ sourceId: "sec.edgar.form4", sourceLocator: "ok", availableAt: utc(Date.parse(decisionAt) - delay), value: { late: false } }));
    const strict = repo.asOf<{ late: boolean }>({ sourceId: "sec.edgar.form4", decisionAt });
    expect(strict.rows.map((r) => r.value.late)).toEqual([false]);
    expect(strict.labels).toEqual([]);
    const optimistic = repo.asOf<{ late: boolean }>({ sourceId: "sec.edgar.form4", decisionAt, processingDelayMs: 0 });
    expect(optimistic.rows).toHaveLength(2);
    expect(optimistic.labels).toContain("OPTIMISTIC_DELAY");
  });
});

describe("Fixture: revision leakage sentinel", () => {
  it("a sentinel present only in the latest vintage never appears in any historical decision", () => {
    const { repo } = rig();
    const eff = T("2026-01-01T00:00:00Z");
    const vintages: [string, number][] = [
      ["2026-02-13", 12],
      ["2026-03-13", 11],
      ["2026-04-10", -777], // sentinel: sign flip exists only in the latest revision
    ];
    for (const [v, value] of vintages) {
      repo.append(
        obs({
          sourceId: "fred.TESTSERIES",
          sourceLocator: `fred/TESTSERIES/${v}`,
          entityId: "TESTSERIES",
          effectiveAt: eff,
          vintageAt: T(`${v}T00:00:00Z`),
          availableAt: zonedToUtc(isoDate(v), 8, 30, "America/New_York"),
          value: { value },
        }),
      );
    }
    // Every decision day from Feb 13 to Apr 10 (inclusive of the release day itself at 13:00Z, which is
    // before 08:30 ET + 60 min) must never see the sentinel.
    for (let d = isoDate("2026-02-13"); d <= "2026-04-10"; d = isoDate(new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10))) {
      const res = repo.asOf<{ value: number }>({ sourceId: "fred.TESTSERIES", decisionAt: T(`${d}T13:00:00Z`) });
      expect(res.rows.some((r) => r.value.value === -777), d).toBe(false);
      // The 2026-03-13 vintage becomes admissible at 13:30Z (08:30 ET + 60 min), after this 13:00Z decision.
      if (d > "2026-03-13" && d < "2026-04-10") expect(res.rows.map((r) => r.value.value), d).toEqual([11]);
    }
    const after = repo.asOf<{ value: number }>({ sourceId: "fred.TESTSERIES", decisionAt: T("2026-04-10T14:00:00Z") });
    expect(after.rows.map((r) => r.value.value)).toEqual([-777]);
  });
});

describe("Fixture: Form 4 acceptance versus transaction", () => {
  it("Monday transaction accepted Wednesday 18:10 ET is available Thursday 06:00 ET with AFTER_HOURS_ACCEPTANCE", () => {
    const tx = isoDate("2026-09-14"); // Monday
    const acceptance = zonedToUtc(isoDate("2026-09-16"), 18, 10, "America/New_York"); // Wednesday
    const r = form4Flags(tx, acceptance, cal);
    expect(r.availableAt).toBe("2026-09-17T10:00:00.000Z"); // 06:00 EDT
    expect(r.flags).toEqual(["AFTER_HOURS_ACCEPTANCE"]);
    expect(form4Deadline(tx, cal)).toBe(zonedToUtc(isoDate("2026-09-16"), 22, 0, "America/New_York"));
    const { repo } = rig();
    repo.append(obs({ sourceId: "sec.edgar.form4", observedAt: T(`${tx}T00:00:00Z`), availableAt: r.availableAt, qualityFlags: r.flags, value: { code: "P" } }));
    for (const day of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
      expect(repo.asOf({ sourceId: "sec.edgar.form4", decisionAt: T(`${day}T21:00:00Z`) }).rows, day).toHaveLength(0);
    }
    expect(repo.asOf({ sourceId: "sec.edgar.form4", decisionAt: T("2026-09-17T10:14:59Z") }).rows).toHaveLength(0);
    expect(repo.asOf({ sourceId: "sec.edgar.form4", decisionAt: T("2026-09-17T10:15:00Z") }).rows).toHaveLength(1);
  });

  it("a filing accepted after the two-business-day deadline is LATE_FILING but still valid", () => {
    const tx = isoDate("2026-09-14");
    const late = zonedToUtc(isoDate("2026-09-18"), 9, 0, "America/New_York");
    expect(form4Flags(tx, late, cal).flags).toEqual(["LATE_FILING"]);
    // Friday before Labor Day: Monday is a holiday, so the two business days are Tue 9/8 and Wed 9/9.
    const holidayAdjacent = form4Deadline(isoDate("2026-09-04"), cal);
    expect(holidayAdjacent).toBe(zonedToUtc(isoDate("2026-09-09"), 22, 0, "America/New_York"));
  });

  it("a Saturday acceptance disseminates the next business day at 06:00 ET", () => {
    const sat = zonedToUtc(isoDate("2026-09-19"), 11, 0, "America/New_York");
    expect(secDissemination(sat, cal).availableAt).toBe("2026-09-21T10:00:00.000Z");
  });
});

describe("Fixture: COT release lag", () => {
  it("Tuesday positions are visible only after Friday 15:30 ET; a holiday Friday moves release to Monday", () => {
    const normal = cotReleaseInstant(isoDate("2026-09-08"), cal);
    expect(normal).toEqual({ availableAt: "2026-09-11T19:30:00.000Z", flags: [] }); // EDT
    const holidayWeek = cotReleaseInstant(isoDate("2026-06-30"), cal); // Friday 2026-07-03 is a holiday
    expect(holidayWeek).toEqual({ availableAt: "2026-07-06T19:30:00.000Z", flags: ["RELEASE_DELAYED"] });
    const { repo } = rig();
    repo.append(obs({ sourceId: "cftc.cot.legacy", observedAt: T("2026-09-08T00:00:00Z"), availableAt: normal.availableAt, value: { week: 2 } }));
    repo.append(obs({ sourceId: "cftc.cot.legacy", sourceLocator: "prev", observedAt: T("2026-09-01T00:00:00Z"), availableAt: cotReleaseInstant(isoDate("2026-09-01"), cal).availableAt, value: { week: 1 } }));
    // Wednesday decision sees only the prior week's report.
    const wed = repo.asOf<{ week: number }>({ sourceId: "cftc.cot.legacy", decisionAt: T("2026-09-09T20:00:00Z") });
    expect(wed.rows.map((r) => r.value.week)).toEqual([1]);
    expect(() => cotReleaseInstant(isoDate("2026-09-09"), cal)).toThrow(RangeError);
  });
});

describe("Fixture: 13F lag", () => {
  it("quarter-end holdings filed on day 45 are unavailable at quarter end plus 44 days and are research context only", () => {
    const qEnd = quarterEndOf(isoDate("2026-05-15"));
    expect(qEnd).toBe("2026-06-30");
    const deadline = thirteenFDeadline(qEnd);
    expect(deadline).toBe(zonedToUtc(isoDate("2026-08-14"), 17, 30, "America/New_York"));
    const { repo } = rig();
    repo.append(obs({ sourceId: "sec.edgar.13f", effectiveAt: T("2026-06-30T00:00:00Z"), availableAt: deadline, value: { holdings: 1 } }));
    expect(repo.asOf({ sourceId: "sec.edgar.13f", decisionAt: T("2026-08-13T21:00:00Z") }).rows).toHaveLength(0);
    expect(repo.asOf({ sourceId: "sec.edgar.13f", decisionAt: T("2026-08-14T22:00:00Z") }).rows).toHaveLength(1);
  });
});

describe("Fixture: early close and DST", () => {
  it("a daily bar on the day after Thanksgiving is observed at 13:00 ET and available an hour later", () => {
    const t = dailyBarTimes(isoDate("2026-11-27"), cal);
    expect(t.observedAt).toBe("2026-11-27T18:00:00.000Z");
    expect(t.availableAt).toBe("2026-11-27T19:00:00.000Z");
    expect(t.flags).toEqual(["AVAILABLE_AT_ESTIMATED"]);
    expect(dailyBarTimes(isoDate("2026-11-25"), cal).observedAt).toBe("2026-11-25T21:00:00.000Z"); // EST regular close
    expect(() => dailyBarTimes(isoDate("2026-11-26"), cal)).toThrow(); // holiday, not a session
  });

  it("COT release maps to 19:30 UTC in summer and 20:30 UTC in winter", () => {
    expect(cotReleaseInstant(isoDate("2026-07-14"), cal).availableAt).toBe("2026-07-17T19:30:00.000Z");
    expect(cotReleaseInstant(isoDate("2026-12-08"), cal).availableAt).toBe("2026-12-11T20:30:00.000Z");
    // Transition weeks: 2026-03-08 (spring forward) and 2026-11-01 (fall back)
    expect(cotReleaseInstant(isoDate("2026-03-03"), cal).availableAt).toBe("2026-03-06T20:30:00.000Z");
    expect(cotReleaseInstant(isoDate("2026-03-10"), cal).availableAt).toBe("2026-03-13T19:30:00.000Z");
    expect(cotReleaseInstant(isoDate("2026-10-27"), cal).availableAt).toBe("2026-10-30T19:30:00.000Z");
    expect(cotReleaseInstant(isoDate("2026-11-03"), cal).availableAt).toBe("2026-11-06T20:30:00.000Z");
  });
});

describe("Fixture: corrected bar and temporal inversion", () => {
  it("both rows retained; the decision at the original time keeps the original hash", () => {
    const { repo } = rig();
    const locator = "alpaca/bars/1d/VTI/2026-09-08";
    const first = repo.append(obs({ sourceId: "alpaca.iex.bars.1d", sourceLocator: locator, entityId: "VTI", availableAt: T("2026-09-08T21:00:00Z"), value: { close: "300.10" } }));
    const fixed = repo.append(obs({ sourceId: "alpaca.iex.bars.1d", sourceLocator: locator, entityId: "VTI", availableAt: T("2026-09-09T21:00:00Z"), value: { close: "300.15" } }));
    expect(fixed.conflict).toBe(true);
    const original = repo.asOf<{ close: string }>({ sourceId: "alpaca.iex.bars.1d", decisionAt: T("2026-09-08T22:00:00Z") });
    expect(original.rows[0]?.id).toBe(first.id);
    expect(original.rows[0]?.rawContentHash).toBe(H(JSON.stringify({ close: "300.10" })));
    const later = repo.asOf<{ close: string }>({ sourceId: "alpaca.iex.bars.1d", decisionAt: T("2026-09-10T00:00:00Z") });
    expect(later.rows[0]?.id).toBe(fixed.id);
    expect(later.rows[0]?.qualityFlags).toContain("CORRECTED");
    expect(repo.byId(first.id)?.value).toEqual({ close: "300.10" });
  });

  it("a parser emitting availableAt before observedAt is rejected at write time", () => {
    const { repo } = rig();
    expect(() =>
      repo.append(obs({ sourceId: "test.x", observedAt: T("2026-09-08T21:00:00Z"), availableAt: T("2026-09-08T20:59:59Z"), value: 1 })),
    ).toThrow(TemporalInversionError);
    expect(repo.count()).toBe(0);
  });
});

describe("Fixture: artifact integrity", () => {
  it("a byte flip is detected and referencing observations are excluded from decisions", () => {
    const { repo, store } = rig();
    const bytes = Buffer.from(JSON.stringify({ filing: "10-K", text: "x".repeat(500) }));
    const { hash } = store.put(bytes, { locator: "sec/0000012345-26-000001", retention: "filings" });
    repo.append(obs({ sourceId: "sec.edgar.submissions", rawContentHash: hash, availableAt: T("2026-09-01T10:00:00Z"), value: { form: "10-K" } }));
    expect(repo.asOf({ sourceId: "sec.edgar.submissions", decisionAt: T("2026-09-02T00:00:00Z") }).rows).toHaveLength(1);
    const path = store.meta(hash)?.path ?? "";
    const buf = readFileSync(path);
    buf[8] = buf[8] === 0 ? 255 : 0;
    writeFileSync(path, buf);
    const verdict = store.verify(hash);
    expect(verdict.ok).toBe(false);
    // The daily verify job marks referencing rows ARTIFACT_MISSING by appending a corrected row.
    const stale = repo.all("sec.edgar.submissions").filter((r) => r.rawContentHash === hash);
    for (const r of stale) {
      repo.append({ ...r, qualityFlags: [...r.qualityFlags, "ARTIFACT_MISSING"], ingestedAt: T("2026-12-31T00:00:00Z") });
    }
    // Excluded once flagged: the corrected row (latest) carries ARTIFACT_MISSING and is barred from decisions,
    // and the collapse rule never falls back to a superseded row.
    expect(repo.asOf({ sourceId: "sec.edgar.submissions", decisionAt: T("2027-01-01T00:00:00Z") }).rows).toHaveLength(0);
  });
});
