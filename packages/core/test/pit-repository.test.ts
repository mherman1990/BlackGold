import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, utc, type Db, type UtcInstant } from "@blackgold/shared";
import { PointInTimeRepository, TemporalInversionError, defaultProcessingDelayMs, openCoreDb, type PointInTimeObservation } from "../src/index.ts";

const H = `sha256:${sha256Hex("raw")}`;
const H2 = `sha256:${sha256Hex("raw-2")}`;
const T = (s: string): UtcInstant => utc(s);

function repo(): PointInTimeRepository {
  const dir = mkdtempSync(join(tmpdir(), "bg-pit-"));
  return new PointInTimeRepository(openCoreDb({ dbPath: join(dir, "p.sqlite") }).db, { clock: () => Date.parse("2026-09-08T00:00:00Z") });
}

function obs(over: Partial<PointInTimeObservation<{ v: number }>> & { v?: number } = {}): PointInTimeObservation<{ v: number }> {
  const { v, ...rest } = over;
  return {
    sourceId: "test.series",
    sourceLocator: "loc-1",
    entityId: "E1",
    effectiveAt: T("2026-09-01T00:00:00Z"),
    availableAt: T("2026-09-02T12:30:00Z"),
    ingestedAt: T("2026-09-08T00:00:00Z"),
    rawContentHash: H,
    adapterVersion: "1.0.0",
    parserVersion: "1.0.0",
    value: { v: v ?? 1 },
    qualityFlags: [],
    ...rest,
  };
}

describe("PointInTimeRepository.append", () => {
  it("rejects temporal inversion at write time", () => {
    const r = repo();
    expect(() => r.append(obs({ availableAt: T("2026-08-31T00:00:00Z") }))).toThrow(TemporalInversionError);
    expect(() => r.append(obs({ observedAt: T("2026-09-03T00:00:00Z") }))).toThrow(TemporalInversionError);
    expect(r.count()).toBe(0);
  });

  it("deduplicates identical rows and keeps both sides of a conflict, flagging the newer CORRECTED", () => {
    const r = repo();
    const a = r.append(obs());
    const b = r.append(obs());
    expect(b).toEqual({ id: a.id, deduplicated: true, conflict: false });
    const c = r.append(obs({ v: 2, rawContentHash: H2 }));
    expect(c.conflict).toBe(true);
    expect(r.count()).toBe(2);
    expect(r.byId(c.id)?.qualityFlags).toContain("CORRECTED");
    expect(r.byId(a.id)?.value.v).toBe(1); // the original is untouched
  });

  it("observations are append-only at the database level", () => {
    const r = repo();
    r.append(obs());
    const db = (r as unknown as { db: Db }).db;
    expect(() => {
      db.exec("UPDATE observations SET value_json = '{}' WHERE id = 1");
    }).toThrow(/append-only/);
    expect(() => {
      db.exec("DELETE FROM observations");
    }).toThrow(/append-only/);
  });
});

describe("PointInTimeRepository.asOf", () => {
  it("applies availableAt + processingDelay <= decisionAt and labels zero-delay runs OPTIMISTIC_DELAY", () => {
    const r = repo();
    r.append(obs({ sourceId: "fred.CPI", availableAt: T("2026-09-02T12:30:00Z") }));
    // fred default delay is 60 minutes.
    expect(defaultProcessingDelayMs("fred.CPI")).toBe(60 * 60_000);
    expect(r.asOf({ sourceId: "fred.CPI", decisionAt: T("2026-09-02T13:29:59Z") }).rows).toHaveLength(0);
    expect(r.asOf({ sourceId: "fred.CPI", decisionAt: T("2026-09-02T13:30:00Z") }).rows).toHaveLength(1);
    const optimistic = r.asOf({ sourceId: "fred.CPI", decisionAt: T("2026-09-02T12:30:00Z"), processingDelayMs: 0 });
    expect(optimistic.rows).toHaveLength(1);
    expect(optimistic.labels).toEqual(["OPTIMISTIC_DELAY"]);
  });

  it("selects the greatest admissible vintage per effective period and never the current revision by default", () => {
    const r = repo();
    const eff = T("2026-06-01T00:00:00Z");
    r.append(obs({ sourceId: "fred.X", effectiveAt: eff, vintageAt: T("2026-07-10T00:00:00Z"), availableAt: T("2026-07-10T12:30:00Z"), v: 100 }));
    r.append(obs({ sourceId: "fred.X", effectiveAt: eff, vintageAt: T("2026-08-10T00:00:00Z"), availableAt: T("2026-08-10T12:30:00Z"), v: 90, rawContentHash: H2 }));
    // Planted sentinel that exists only in the latest revision.
    r.append(obs({ sourceId: "fred.X", effectiveAt: eff, vintageAt: T("2026-09-10T00:00:00Z"), availableAt: T("2026-09-10T12:30:00Z"), v: -999, rawContentHash: `sha256:${sha256Hex("v3")}` }));
    const july = r.asOf<{ v: number }>({ sourceId: "fred.X", decisionAt: T("2026-07-20T00:00:00Z") });
    expect(july.rows.map((x) => x.value.v)).toEqual([100]);
    const august = r.asOf<{ v: number }>({ sourceId: "fred.X", decisionAt: T("2026-08-20T00:00:00Z") });
    expect(august.rows.map((x) => x.value.v)).toEqual([90]);
    const later = r.asOf<{ v: number }>({ sourceId: "fred.X", decisionAt: T("2026-12-01T00:00:00Z") });
    expect(later.rows.map((x) => x.value.v)).toEqual([-999]);
    // The sentinel never appears in any decision before its own availability.
    for (const d of ["2026-07-01", "2026-08-01", "2026-09-10"]) {
      const res = r.asOf<{ v: number }>({ sourceId: "fred.X", decisionAt: T(`${d}T13:00:00Z`) });
      expect(res.rows.some((x) => x.value.v === -999), d).toBe(false);
    }
  });

  it("a correction supersedes the original only once the correction itself is available", () => {
    const r = repo();
    r.append(obs({ sourceId: "market.bars", sourceLocator: "SPY/2026-09-01", availableAt: T("2026-09-01T21:00:00Z"), v: 450 }));
    r.append(obs({ sourceId: "market.bars", sourceLocator: "SPY/2026-09-01", availableAt: T("2026-09-03T21:00:00Z"), v: 451, rawContentHash: H2 }));
    const early = r.asOf<{ v: number }>({ sourceId: "market.bars", decisionAt: T("2026-09-02T12:00:00Z") });
    expect(early.rows.map((x) => x.value.v)).toEqual([450]);
    const late = r.asOf<{ v: number }>({ sourceId: "market.bars", decisionAt: T("2026-09-04T12:00:00Z") });
    expect(late.rows.map((x) => x.value.v)).toEqual([451]);
    expect(late.rows[0]?.qualityFlags).toContain("CORRECTED");
  });

  it("excludes rows whose quality codes bar decisions and honours snapshots", () => {
    const r = repo();
    const a = r.append(obs({ sourceLocator: "a" }));
    r.append(obs({ sourceLocator: "b", qualityFlags: ["ARTIFACT_MISSING"], rawContentHash: H2 }));
    const snap = r.createSnapshot("test", "before c");
    r.append(obs({ sourceLocator: "c", rawContentHash: `sha256:${sha256Hex("c")}` }));
    const all = r.asOf({ sourceId: "test.series", decisionAt: T("2026-12-01T00:00:00Z") });
    expect(all.rows.map((x) => x.sourceLocator).sort()).toEqual(["a", "c"]);
    const scoped = r.asOf({ sourceId: "test.series", decisionAt: T("2026-12-01T00:00:00Z"), snapshotId: snap.snapshotId });
    expect(scoped.rows.map((x) => x.id)).toEqual([a.id]);
    expect(r.snapshot(snap.snapshotId).maxObservationId).toBe(2);
    expect(r.latestAvailableAt("test.series")).toBe("2026-09-02T12:30:00.000Z");
  });
});
