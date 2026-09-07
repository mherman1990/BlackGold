import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dec, isoDate, sha256Hex, utc, type Db } from "@blackgold/shared";
import { EntityMap, PointInTimeRepository, SymbolRangeConflictError, corporateActionObservation, openCoreDb } from "../src/index.ts";

const d = isoDate;
const H = `sha256:${sha256Hex("ca")}`;

function setup(): { db: Db; map: EntityMap; pit: PointInTimeRepository } {
  const dir = mkdtempSync(join(tmpdir(), "bg-entity-"));
  const db = openCoreDb({ dbPath: join(dir, "e.sqlite") }).db;
  const clock = (): number => Date.parse("2026-09-08T00:00:00Z");
  return { db, map: new EntityMap(db, { clock }), pit: new PointInTimeRepository(db, { clock }) };
}

describe("EntityMap", () => {
  it("seeds identity rows for the frozen ETF universe and resolves by date", () => {
    const { map } = setup();
    map.seedIdentity(["VTI", "BIL"], d("2007-06-01"));
    expect(map.resolve("VTI", d("2026-01-02"))).toBe("VTI");
    expect(map.resolve("VTI", d("2007-05-31"))).toBeUndefined();
    expect(map.resolve("SPY", d("2026-01-02"))).toBeUndefined();
    expect(map.symbolsFor("BIL")).toEqual(["BIL"]);
    // Re-seeding is a no-op.
    const again = map.seedIdentity(["VTI"], d("2007-06-01"));
    expect(map.rangesForSymbol("VTI")).toHaveLength(1);
    expect(again[0]?.entityId).toBe("VTI");
  });

  it("a symbol change mid-holding keeps continuity via entityId and exposes every symbol carried", () => {
    const { map } = setup();
    map.register({ symbol: "OLD", entityId: "E1", effectiveFrom: d("2020-01-02"), source: "seed:test" });
    map.applyAction({ kind: "SYMBOL_CHANGE", entityId: "E1", oldSymbol: "OLD", newSymbol: "NEW", effective: d("2024-06-03") });
    expect(map.resolve("OLD", d("2024-06-02"))).toBe("E1");
    expect(map.resolve("OLD", d("2024-06-03"))).toBeUndefined();
    expect(map.resolve("NEW", d("2024-06-03"))).toBe("E1");
    expect(map.resolve("NEW", d("2024-06-02"))).toBeUndefined();
    expect(map.symbolsFor("E1")).toEqual(["NEW", "OLD"]); // restricted-list matching sees both
    expect(map.symbolOn("E1", d("2022-01-03"))).toBe("OLD");
    expect(map.symbolOn("E1", d("2025-01-03"))).toBe("NEW");
    const old = map.rangesForSymbol("OLD")[0];
    expect(old?.effectiveTo).toBe("2024-06-02");
  });

  it("a symbol reused after a delisting resolves by date range and fails closed in the dead zone", () => {
    const { map } = setup();
    map.register({ symbol: "ABC", entityId: "E1", effectiveFrom: d("2015-01-02"), source: "seed:test" });
    map.applyAction({ kind: "DELISTING", entityId: "E1", lastTradeDate: d("2019-05-10"), reason: "acquired", finalPrice: new Dec("12") });
    map.register({ symbol: "ABC", entityId: "E2", effectiveFrom: d("2021-03-01"), source: "seed:test" });
    expect(map.resolve("ABC", d("2018-01-02"))).toBe("E1");
    expect(map.resolve("ABC", d("2019-05-10"))).toBe("E1");
    expect(map.resolve("ABC", d("2020-01-02"))).toBeUndefined();
    expect(map.resolve("ABC", d("2022-01-03"))).toBe("E2");
    // Overlapping a closed range of another entity is a conflict, not a silent overwrite.
    expect(() => map.register({ symbol: "ABC", entityId: "E3", effectiveFrom: d("2017-01-03"), source: "seed:test" })).toThrow(SymbolRangeConflictError);
    // Registering a new entity on an open range closes the old one the day before.
    map.register({ symbol: "XYZ", entityId: "E4", effectiveFrom: d("2010-01-04"), source: "seed:test" });
    map.register({ symbol: "XYZ", entityId: "E5", effectiveFrom: d("2012-01-03"), source: "seed:test" });
    expect(map.resolve("XYZ", d("2012-01-02"))).toBe("E4");
    expect(map.resolve("XYZ", d("2012-01-03"))).toBe("E5");
  });

  it("merger closes the target; spin-off opens the child", () => {
    const { map } = setup();
    map.register({ symbol: "TGT", entityId: "T", effectiveFrom: d("2010-01-04"), source: "seed:test" });
    map.applyAction({ kind: "MERGER", entityId: "T", acquirer: "A", terms: { cashPerShare: new Dec("50") }, effective: d("2020-03-02") });
    expect(map.resolve("TGT", d("2020-03-01"))).toBe("T");
    expect(map.resolve("TGT", d("2020-03-02"))).toBeUndefined();
    map.register({ symbol: "XLF", entityId: "XLF", effectiveFrom: d("1998-12-22"), source: "seed:test" });
    map.applyAction({ kind: "SPINOFF", parent: "XLF", child: "XLRE", ratio: new Dec("0.139146"), exDate: d("2015-10-08") });
    expect(map.resolve("XLRE", d("2016-01-04"))).toBe("XLRE");
    expect(map.resolve("XLRE", d("2015-10-07"))).toBeUndefined();
    expect(map.resolve("XLF", d("2016-01-04"))).toBe("XLF");
  });

  it("ranges are append-only at the database level: only closing an open range is permitted", () => {
    const { db, map } = setup();
    map.register({ symbol: "OLD", entityId: "E1", effectiveFrom: d("2020-01-02"), source: "seed:test" });
    expect(() => {
      db.exec("UPDATE entity_symbols SET symbol = 'HACK' WHERE symbol = 'OLD'");
    }).toThrow(/may only be closed/);
    expect(() => {
      db.exec("UPDATE entity_symbols SET entity_id = 'E9' WHERE symbol = 'OLD'");
    }).toThrow(/may only be closed/);
    expect(() => {
      db.exec("DELETE FROM entity_symbols");
    }).toThrow(/append-only/);
    db.exec("UPDATE entity_symbols SET effective_to = '2021-01-01' WHERE symbol = 'OLD'");
    expect(() => {
      db.exec("UPDATE entity_symbols SET effective_to = '2022-01-01' WHERE symbol = 'OLD'");
    }).toThrow(/may only be closed/);
  });

  it("syncFromRepository applies only identity actions available at decisionAt", () => {
    const { map, pit } = setup();
    map.register({ symbol: "OLD", entityId: "E1", effectiveFrom: d("2020-01-02"), source: "seed:test" });
    const ingestedAt = utc("2026-09-08T00:00:00Z");
    pit.append(
      corporateActionObservation(
        { kind: "SYMBOL_CHANGE", entityId: "E1", oldSymbol: "OLD", newSymbol: "NEW", effective: d("2024-06-03") },
        { sourceLocator: "ca/E1/2024-06-03", availableAt: utc("2024-06-03T00:00:00Z"), ingestedAt, rawContentHash: H, adapterVersion: "1.0.0", parserVersion: "1.0.0" },
      ),
    );
    const early = map.syncFromRepository(pit, utc("2024-06-02T00:00:00Z"));
    expect(early.applied).toBe(0);
    expect(map.resolve("OLD", d("2025-01-02"))).toBe("E1"); // the change is not yet known
    // corporate_action.* carries a 15-minute processing delay.
    const onTime = map.syncFromRepository(pit, utc("2024-06-03T00:15:00Z"));
    expect(onTime.applied).toBe(1);
    expect(map.resolve("OLD", d("2025-01-02"))).toBeUndefined();
    expect(map.resolve("NEW", d("2025-01-02"))).toBe("E1");
    // Idempotent on re-sync.
    expect(map.syncFromRepository(pit, utc("2026-01-01T00:00:00Z")).applied).toBe(1);
    expect(map.rangesForSymbol("NEW")).toHaveLength(1);
  });
});
