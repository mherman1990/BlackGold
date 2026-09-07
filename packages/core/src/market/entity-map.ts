import { addDays, nowUtc, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { PointInTimeRepository } from "../data/pit/repository.ts";
import { actionEffectiveDate, corporateActionFromValue, corporateActionSourceId, type CorporateAction } from "./types.ts";

/**
 * Date-effective symbol -> entity mapping (docs/DATA_PROVENANCE_SPEC.md section 6a). Tickers are not
 * stable identifiers; every market observation resolves to a stable `entityId` through this table.
 *
 * Rows are `(symbol, effectiveFrom, effectiveTo | null) -> entityId`. Ranges are append-only; the only
 * permitted update is closing an open range (a trigger enforces this). A symbol reused after a delisting
 * resolves by date range; a symbol that maps to two entities on one date fails closed (undefined).
 */
export type SymbolRange = {
  id: number;
  symbol: string;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  entityId: string;
  source: string;
};

export type RegisterSymbol = {
  symbol: string;
  entityId: string;
  effectiveFrom: IsoDate;
  effectiveTo?: IsoDate | null;
  /** Provenance: "seed:<name>", "corporate_action.<KIND>", or a sourceLocator. */
  source: string;
};

export class SymbolRangeConflictError extends Error {
  constructor(symbol: string, detail: string) {
    super(`Symbol range conflict for ${symbol}: ${detail}`);
    this.name = "SymbolRangeConflictError";
  }
}

type Row = { id: number; symbol: string; effective_from: string; effective_to: string | null; entity_id: string; source: string };

function rowToRange(r: Row): SymbolRange {
  return {
    id: r.id,
    symbol: r.symbol,
    effectiveFrom: r.effective_from as IsoDate,
    effectiveTo: r.effective_to === null ? null : (r.effective_to as IsoDate),
    entityId: r.entity_id,
    source: r.source,
  };
}

export class EntityMap {
  private readonly db: Db;
  private readonly clock: () => number;

  constructor(db: Db, opts: { clock?: () => number } = {}) {
    this.db = db;
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Register a range. An identical existing range is a no-op. An existing OPEN range for the same symbol
   * and a different entity that started before `effectiveFrom` is closed the day before. Overlaps with a
   * closed range of a different entity throw: the caller must supply consistent dates.
   */
  register(r: RegisterSymbol): SymbolRange {
    const effectiveTo = r.effectiveTo ?? null;
    if (effectiveTo !== null && effectiveTo < r.effectiveFrom) throw new SymbolRangeConflictError(r.symbol, "effectiveTo precedes effectiveFrom");
    return this.db.transaction(() => {
      const existing = this.rangesForSymbol(r.symbol);
      for (const e of existing) {
        if (e.entityId === r.entityId && e.effectiveFrom === r.effectiveFrom && e.effectiveTo === effectiveTo) return e;
        if (e.entityId === r.entityId) continue; // same entity, different range (e.g. relisting under the same id)
        const overlaps = e.effectiveFrom <= (effectiveTo ?? "9999-12-31") && (e.effectiveTo ?? "9999-12-31") >= r.effectiveFrom;
        if (!overlaps) continue;
        if (e.effectiveTo === null && e.effectiveFrom < r.effectiveFrom) {
          this.close(e.id, addDays(r.effectiveFrom, -1));
          continue;
        }
        throw new SymbolRangeConflictError(r.symbol, `${e.entityId} holds ${e.effectiveFrom}..${e.effectiveTo ?? "open"}, new ${r.entityId} from ${r.effectiveFrom}`);
      }
      const result = this.db
        .prepare("INSERT INTO entity_symbols (symbol, effective_from, effective_to, entity_id, source, registered_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(r.symbol, r.effectiveFrom, effectiveTo, r.entityId, r.source, nowUtc(this.clock));
      return { id: Number(result.lastInsertRowid), symbol: r.symbol, effectiveFrom: r.effectiveFrom, effectiveTo, entityId: r.entityId, source: r.source };
    });
  }

  /** Seed rows where symbol == entityId (the frozen ETF universe). */
  seedIdentity(symbols: readonly string[], effectiveFrom: IsoDate, source = "seed:identity"): SymbolRange[] {
    return this.db.transaction(() => symbols.map((s) => this.register({ symbol: s, entityId: s, effectiveFrom, source })));
  }

  /** Close every open range of `entityId` at `lastDate` (delisting, merger target). */
  closeEntity(entityId: string, lastDate: IsoDate): number {
    return this.db.transaction(() => {
      let n = 0;
      for (const r of this.rangesForEntity(entityId)) {
        if (r.effectiveTo === null) {
          if (r.effectiveFrom > lastDate) throw new SymbolRangeConflictError(r.symbol, `cannot close at ${lastDate} before start ${r.effectiveFrom}`);
          this.close(r.id, lastDate);
          n++;
        }
      }
      return n;
    });
  }

  /** The entity a symbol denoted on `date`, or undefined (UNKNOWN_ENTITY) when none or ambiguous. */
  resolve(symbol: string, date: IsoDate): string | undefined {
    const rows = this.db
      .prepare("SELECT DISTINCT entity_id FROM entity_symbols WHERE symbol = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)")
      .all(symbol, date, date) as { entity_id: string }[];
    if (rows.length !== 1) return undefined;
    return rows[0]?.entity_id;
  }

  /** Every symbol the entity has ever carried (restricted-list matching runs against all of them). */
  symbolsFor(entityId: string): string[] {
    const rows = this.db.prepare("SELECT DISTINCT symbol FROM entity_symbols WHERE entity_id = ? ORDER BY symbol").all(entityId) as { symbol: string }[];
    return rows.map((r) => r.symbol);
  }

  /** The symbol an entity traded under on `date`, if any. */
  symbolOn(entityId: string, date: IsoDate): string | undefined {
    const rows = this.db
      .prepare("SELECT symbol FROM entity_symbols WHERE entity_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC")
      .all(entityId, date, date) as { symbol: string }[];
    return rows[0]?.symbol;
  }

  rangesForSymbol(symbol: string): SymbolRange[] {
    return (this.db.prepare("SELECT * FROM entity_symbols WHERE symbol = ? ORDER BY effective_from, id").all(symbol) as Row[]).map(rowToRange);
  }

  rangesForEntity(entityId: string): SymbolRange[] {
    return (this.db.prepare("SELECT * FROM entity_symbols WHERE entity_id = ? ORDER BY effective_from, id").all(entityId) as Row[]).map(rowToRange);
  }

  /**
   * Apply one corporate action's identity effect. Actions with no identity effect are ignored.
   * SYMBOL_CHANGE closes the old symbol the day before `effective` and opens the new one; MERGER and
   * DELISTING close the target's symbols; SPINOFF opens the child's symbol from the ex-date.
   */
  applyAction(action: CorporateAction, source = corporateActionSourceId(action.kind)): void {
    switch (action.kind) {
      case "SYMBOL_CHANGE": {
        this.db.transaction(() => {
          for (const r of this.rangesForEntity(action.entityId)) {
            if (r.symbol === action.oldSymbol && r.effectiveTo === null && r.effectiveFrom < action.effective) this.close(r.id, addDays(action.effective, -1));
          }
          this.register({ symbol: action.newSymbol, entityId: action.entityId, effectiveFrom: action.effective, source });
        });
        return;
      }
      case "MERGER":
        this.closeEntity(action.entityId, addDays(action.effective, -1));
        return;
      case "DELISTING":
        this.closeEntity(action.entityId, action.lastTradeDate);
        return;
      case "SPINOFF":
        this.register({ symbol: action.childSymbol ?? action.child, entityId: action.child, effectiveFrom: action.exDate, source });
        return;
      case "SPLIT":
      case "CASH_DIVIDEND":
      case "STALE_BAR":
      case "CORRECTED_BAR":
        return;
    }
  }

  /**
   * Load identity-affecting actions available at `decisionAt` through the point-in-time read path and
   * apply them in effective-date order. Only actions the decision could have known about are applied.
   */
  syncFromRepository(pit: PointInTimeRepository, decisionAt: UtcInstant, opts: { snapshotId?: string } = {}): { applied: number; labels: string[] } {
    const kinds = ["SYMBOL_CHANGE", "MERGER", "SPINOFF", "DELISTING"] as const;
    const actions: { action: CorporateAction; id: number }[] = [];
    const labels = new Set<string>();
    for (const kind of kinds) {
      const q = { sourceId: corporateActionSourceId(kind), decisionAt, ...(opts.snapshotId === undefined ? {} : { snapshotId: opts.snapshotId }) };
      const res = pit.asOf(q);
      for (const l of res.labels) labels.add(l);
      for (const row of res.rows) actions.push({ action: corporateActionFromValue(row.value), id: row.id });
    }
    actions.sort((a, b) => {
      const da = actionEffectiveDate(a.action);
      const db = actionEffectiveDate(b.action);
      return da < db ? -1 : da > db ? 1 : a.id - b.id;
    });
    this.db.transaction(() => {
      for (const a of actions) this.applyAction(a.action);
    });
    return { applied: actions.length, labels: [...labels] };
  }

  private close(id: number, effectiveTo: IsoDate): void {
    this.db.prepare("UPDATE entity_symbols SET effective_to = ? WHERE id = ? AND effective_to IS NULL").run(effectiveTo, id);
  }
}
