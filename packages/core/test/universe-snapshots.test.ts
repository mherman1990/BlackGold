import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoDate, utc } from "@blackgold/shared";
import {
  ETF_TREND_VOL_UNIVERSE_ID,
  PointInTimeRepository,
  UniverseStore,
  blocksPromotionEvidence,
  frozenEtfUniverse,
  labelsFor,
  openCoreDb,
} from "../src/index.ts";

function setup(): { pit: PointInTimeRepository; store: UniverseStore } {
  const dir = mkdtempSync(join(tmpdir(), "bg-universe-"));
  const clock = (): number => Date.parse("2026-09-08T00:00:00Z");
  const pit = new PointInTimeRepository(openCoreDb({ dbPath: join(dir, "u.sqlite") }).db, { clock });
  return { pit, store: new UniverseStore(pit, { clock }) };
}

describe("UniverseStore", () => {
  it("membersAsOf respects availableAt and returns the newest available snapshot", () => {
    const { store } = setup();
    store.addSnapshot({
      universeId: "eq_test",
      effectiveAt: utc("2026-01-01T00:00:00Z"),
      availableAt: utc("2026-01-05T00:00:00Z"), // membership published four days later
      members: ["E1", "E2"],
      survivorshipFree: true,
      source: "test",
    });
    store.addSnapshot({
      universeId: "eq_test",
      effectiveAt: utc("2026-04-01T00:00:00Z"),
      availableAt: utc("2026-04-03T00:00:00Z"),
      members: ["E2", "E3"],
      survivorshipFree: true,
      source: "test",
    });
    expect(store.membersAsOf("eq_test", utc("2026-01-04T23:59:59Z"))).toBeUndefined();
    const jan = store.membersAsOf("eq_test", utc("2026-01-05T00:00:00Z"));
    expect(jan?.members).toEqual(["E1", "E2"]);
    expect(jan?.snapshotEffectiveAt).toBe("2026-01-01T00:00:00.000Z");
    expect(jan?.labels).toEqual([]);
    // Between the April effective date and its publication the January snapshot still governs.
    expect(store.membersAsOf("eq_test", utc("2026-04-02T00:00:00Z"))?.members).toEqual(["E1", "E2"]);
    expect(store.membersAsOf("eq_test", utc("2026-04-03T00:00:00Z"))?.members).toEqual(["E2", "E3"]);
    expect(store.membersAsOf("other", utc("2026-12-01T00:00:00Z"))).toBeUndefined();
  });

  it("a snapshot built from a current constituent list carries SURVIVORSHIP_BIASED, which bars promotion evidence", () => {
    const { store, pit } = setup();
    store.addSnapshot({
      universeId: "sp500_current",
      effectiveAt: utc("2010-01-01T00:00:00Z"),
      availableAt: utc("2010-01-01T00:00:00Z"),
      members: ["AAPL", "MSFT"],
      survivorshipFree: false,
      source: "current list projected backwards (defect by construction)",
    });
    const res = store.membersAsOf("sp500_current", utc("2012-01-01T00:00:00Z"));
    expect(res?.labels).toEqual(["SURVIVORSHIP_BIASED"]);
    expect(labelsFor({ survivorshipFree: false })).toEqual(["SURVIVORSHIP_BIASED"]);
    expect(labelsFor({ survivorshipFree: true })).toEqual([]);
    expect(blocksPromotionEvidence(res?.labels ?? [])).toEqual(["SURVIVORSHIP_BIASED"]);
    // The stored observation carries the label as a quality flag too.
    expect(pit.all("universe.sp500_current")[0]?.qualityFlags).toEqual(["SURVIVORSHIP_BIASED"]);
  });

  it("snapshot scoping and dedup: identical snapshots are one row; a later row is invisible under an older pit snapshot", () => {
    const { store, pit } = setup();
    const a = store.addSnapshot({ universeId: "u", effectiveAt: utc("2026-01-01T00:00:00Z"), availableAt: utc("2026-01-01T00:00:00Z"), members: ["B", "A"], survivorshipFree: true, source: "t" });
    const b = store.addSnapshot({ universeId: "u", effectiveAt: utc("2026-01-01T00:00:00Z"), availableAt: utc("2026-01-01T00:00:00Z"), members: ["A", "B"], survivorshipFree: true, source: "t" });
    expect(b.deduplicated).toBe(true);
    expect(b.id).toBe(a.id);
    const snap = pit.createSnapshot("universe", "before feb");
    store.addSnapshot({ universeId: "u", effectiveAt: utc("2026-02-01T00:00:00Z"), availableAt: utc("2026-02-01T00:00:00Z"), members: ["C"], survivorshipFree: true, source: "t" });
    expect(store.membersAsOf("u", utc("2026-03-01T00:00:00Z"))?.members).toEqual(["C"]);
    expect(store.membersAsOf("u", utc("2026-03-01T00:00:00Z"), { snapshotId: snap.snapshotId })?.members).toEqual(["A", "B"]);
    expect(store.history("u")).toHaveLength(2);
  });

  it("frozenEtfUniverse is the charter's 13 risk ETFs plus BIL and is survivorship-free by charter argument", () => {
    const { store } = setup();
    const frozen = frozenEtfUniverse();
    expect(frozen.universeId).toBe(ETF_TREND_VOL_UNIVERSE_ID);
    expect(frozen.members).toHaveLength(14);
    expect([...frozen.members].sort()).toEqual(["BIL", "IWM", "QQQ", "VTI", "VTV", "VUG", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY"]);
    expect(frozen.survivorshipFree).toBe(true);
    store.addSnapshot(frozen);
    expect(store.membersAsOf(ETF_TREND_VOL_UNIVERSE_ID, utc("2007-05-31T00:00:00Z"))).toBeUndefined();
    const res = store.membersAsOf(ETF_TREND_VOL_UNIVERSE_ID, utc("2026-09-08T00:00:00Z"));
    expect(res?.members).toContain("BIL");
    expect(res?.labels).toEqual([]);
    expect(frozenEtfUniverse({ effectiveAt: isoDate("2008-01-02") }).effectiveAt).toBe("2008-01-02T00:00:00.000Z");
  });
});
