import { addDays, addMs, nowUtc, utc, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { PointInTimeRepository } from "../data/pit/repository.ts";
import { actionEffectiveDate, corporateActionFromValue, corporateActionSourceId, dateStartUtc, type CorporateAction } from "./types.ts";

/**
 * Date-effective, bitemporal symbol -> entity mapping (docs/DATA_PROVENANCE_SPEC.md section 6a). Tickers are
 * not stable identifiers; every market observation resolves to a stable `entityId` through this table.
 *
 * Two time axes per row:
 *   - effectiveFrom / effectiveTo: WHEN the symbol denoted the entity (trading dates).
 *   - knownFrom / closeKnownFrom: from WHICH INSTANT the range, and later its closing, were knowable.
 * Resolution at a decision instant D (`knownAt`) sees only rows with knownFrom <= D and treats a close with
 * closeKnownFrom > D as not yet having happened. The table therefore accumulates knowledge monotonically
 * (a later sync never has to be undone) while every earlier decision still resolves exactly as it could have
 * at the time. Without `knownAt` a query sees all current knowledge: operational use only, never a decision.
 *
 * Ranges are append-only; the only permitted update is closing an open range together with the instant the
 * close became known (a trigger enforces this). A symbol reused after a delisting resolves by date range; a
 * symbol that maps to two entities on one date fails closed (undefined).
 */
export type SymbolRange = {
  id: number;
  symbol: string;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  entityId: string;
  source: string;
  knownFrom: UtcInstant;
  closeKnownFrom: UtcInstant | null;
};

export type RegisterSymbol = {
  symbol: string;
  entityId: string;
  effectiveFrom: IsoDate;
  effectiveTo?: IsoDate | null;
  /** Provenance: "seed:<name>", "corporate_action.<KIND>", or a sourceLocator. */
  source: string;
  /** Instant the range became knowable. Defaults to the start of `effectiveFrom` (a listing is public when it trades). */
  knownFrom?: UtcInstant | undefined;
};

/** Point-in-time knowledge bound for a lookup. Omit for current knowledge (operational use only). */
export type KnowledgeOpts = { knownAt?: UtcInstant | undefined };

export class SymbolRangeConflictError extends Error {
  constructor(symbol: string, detail: string) {
    super(`Symbol range conflict for ${symbol}: ${detail}`);
    this.name = "SymbolRangeConflictError";
  }
}

type Row = {
  id: number;
  symbol: string;
  effective_from: string;
  effective_to: string | null;
  entity_id: string;
  source: string;
  known_from: string;
  close_known_from: string | null;
};

function rowToRange(r: Row): SymbolRange {
  return {
    id: r.id,
    symbol: r.symbol,
    effectiveFrom: r.effective_from as IsoDate,
    effectiveTo: r.effective_to === null ? null : (r.effective_to as IsoDate),
    entityId: r.entity_id,
    source: r.source,
    knownFrom: utc(r.known_from),
    closeKnownFrom: r.close_known_from === null ? null : utc(r.close_known_from),
  };
}

/** Sentinel for "all current knowledge"; sorts after every real instant. */
const ALL_KNOWLEDGE = "9999-12-31T23:59:59.999Z";

const OPEN_AT = "(effective_to IS NULL OR effective_to >= ? OR close_known_from > ?) AND known_from <= ?";

export class EntityMap {
  private readonly db: Db;
  private readonly clock: () => number;

  constructor(db: Db, opts: { clock?: () => number } = {}) {
    this.db = db;
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Register a range. An identical existing range is a no-op. An existing OPEN range for the same symbol
   * and a different entity that started before `effectiveFrom` is closed the day before (the close becomes
   * known at the new range's `knownFrom`). Overlaps with a closed range of a different entity throw: the
   * caller must supply consistent dates.
   */
  register(r: RegisterSymbol): SymbolRange {
    const effectiveTo = r.effectiveTo ?? null;
    if (effectiveTo !== null && effectiveTo < r.effectiveFrom) throw new SymbolRangeConflictError(r.symbol, "effectiveTo precedes effectiveFrom");
    const knownFrom = r.knownFrom === undefined ? dateStartUtc(r.effectiveFrom) : utc(r.knownFrom);
    return this.db.transaction(() => {
      const existing = this.rangesForSymbol(r.symbol);
      for (const e of existing) {
        if (e.entityId === r.entityId && e.effectiveFrom === r.effectiveFrom && e.effectiveTo === effectiveTo) return e;
        if (e.entityId === r.entityId) continue; // same entity, different range (e.g. relisting under the same id)
        const overlaps = e.effectiveFrom <= (effectiveTo ?? "9999-12-31") && (e.effectiveTo ?? "9999-12-31") >= r.effectiveFrom;
        if (!overlaps) continue;
        if (e.effectiveTo === null && e.effectiveFrom < r.effectiveFrom) {
          this.close(e.id, addDays(r.effectiveFrom, -1), knownFrom);
          continue;
        }
        throw new SymbolRangeConflictError(r.symbol, `${e.entityId} holds ${e.effectiveFrom}..${e.effectiveTo ?? "open"}, new ${r.entityId} from ${r.effectiveFrom}`);
      }
      const result = this.db
        .prepare(
          `INSERT INTO entity_symbols (symbol, effective_from, effective_to, entity_id, source, registered_at, known_from, close_known_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.symbol, r.effectiveFrom, effectiveTo, r.entityId, r.source, nowUtc(this.clock), knownFrom, effectiveTo === null ? null : knownFrom);
      return {
        id: Number(result.lastInsertRowid),
        symbol: r.symbol,
        effectiveFrom: r.effectiveFrom,
        effectiveTo,
        entityId: r.entityId,
        source: r.source,
        knownFrom,
        closeKnownFrom: effectiveTo === null ? null : knownFrom,
      };
    });
  }

  /** Seed rows where symbol == entityId (the frozen ETF universe), known from the start of `effectiveFrom`. */
  seedIdentity(symbols: readonly string[], effectiveFrom: IsoDate, source = "seed:identity"): SymbolRange[] {
    return this.db.transaction(() => symbols.map((s) => this.register({ symbol: s, entityId: s, effectiveFrom, source })));
  }

  /** Close every open range of `entityId` at `lastDate` (delisting, merger target); the close is known from `knownAt`. */
  closeEntity(entityId: string, lastDate: IsoDate, knownAt: UtcInstant = dateStartUtc(lastDate)): number {
    return this.db.transaction(() => {
      let n = 0;
      for (const r of this.rangesForEntity(entityId)) {
        if (r.effectiveTo === null) {
          if (r.effectiveFrom > lastDate) throw new SymbolRangeConflictError(r.symbol, `cannot close at ${lastDate} before start ${r.effectiveFrom}`);
          this.close(r.id, lastDate, knownAt);
          n++;
        }
      }
      return n;
    });
  }

  /**
   * The entity a symbol denoted on `date` as knowable at `opts.knownAt`, or undefined (UNKNOWN_ENTITY) when
   * none or ambiguous. Decision code must pass `knownAt` (the decision instant).
   */
  resolve(symbol: string, date: IsoDate, opts: KnowledgeOpts = {}): string | undefined {
    const k = knownAtOf(opts);
    const rows = this.db
      .prepare(`SELECT DISTINCT entity_id FROM entity_symbols WHERE symbol = ? AND effective_from <= ? AND ${OPEN_AT}`)
      .all(symbol, date, date, k, k) as { entity_id: string }[];
    if (rows.length !== 1) return undefined;
    return rows[0]?.entity_id;
  }

  /** Every symbol the entity has ever carried (restricted-list matching runs against all of them). */
  symbolsFor(entityId: string, opts: KnowledgeOpts = {}): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT symbol FROM entity_symbols WHERE entity_id = ? AND known_from <= ? ORDER BY symbol")
      .all(entityId, knownAtOf(opts)) as { symbol: string }[];
    return rows.map((r) => r.symbol);
  }

  /** The symbol an entity traded under on `date`, as knowable at `opts.knownAt`, if any. */
  symbolOn(entityId: string, date: IsoDate, opts: KnowledgeOpts = {}): string | undefined {
    const k = knownAtOf(opts);
    const rows = this.db
      .prepare(`SELECT symbol FROM entity_symbols WHERE entity_id = ? AND effective_from <= ? AND ${OPEN_AT} ORDER BY effective_from DESC, id DESC`)
      .all(entityId, date, date, k, k) as { symbol: string }[];
    return rows[0]?.symbol;
  }

  rangesForSymbol(symbol: string): SymbolRange[] {
    return (this.db.prepare("SELECT * FROM entity_symbols WHERE symbol = ? ORDER BY effective_from, id").all(symbol) as Row[]).map(rowToRange);
  }

  rangesForEntity(entityId: string): SymbolRange[] {
    return (this.db.prepare("SELECT * FROM entity_symbols WHERE entity_id = ? ORDER BY effective_from, id").all(entityId) as Row[]).map(rowToRange);
  }

  /**
   * Apply one corporate action's identity effect, knowable from `knownAt` (default: the start of the action's
   * effective date). Actions with no identity effect are ignored. SYMBOL_CHANGE closes the old symbol the day
   * before `effective` and opens the new one; MERGER and DELISTING close the target's symbols; SPINOFF opens
   * the child's symbol from the ex-date.
   */
  applyAction(action: CorporateAction, source = corporateActionSourceId(action.kind), knownAt: UtcInstant = dateStartUtc(actionEffectiveDate(action))): void {
    switch (action.kind) {
      case "SYMBOL_CHANGE": {
        this.db.transaction(() => {
          for (const r of this.rangesForEntity(action.entityId)) {
            if (r.symbol === action.oldSymbol && r.effectiveTo === null && r.effectiveFrom < action.effective) this.close(r.id, addDays(action.effective, -1), knownAt);
          }
          this.register({ symbol: action.newSymbol, entityId: action.entityId, effectiveFrom: action.effective, source, knownFrom: knownAt });
        });
        return;
      }
      case "MERGER":
        this.closeEntity(action.entityId, addDays(action.effective, -1), knownAt);
        return;
      case "DELISTING":
        this.closeEntity(action.entityId, action.lastTradeDate, knownAt);
        return;
      case "SPINOFF":
        this.register({ symbol: action.childSymbol ?? action.child, entityId: action.child, effectiveFrom: action.exDate, source, knownFrom: knownAt });
        return;
      case "SPLIT":
      case "CASH_DIVIDEND":
      case "STALE_BAR":
      case "CORRECTED_BAR":
        return;
    }
  }

  /**
   * Load identity-affecting actions available at `decisionAt` through the point-in-time read path and apply
   * them in effective-date order, each knowable from its own availability instant plus the processing delay
   * the read used. Syncing for a later decision never disturbs an earlier one: resolve with that earlier
   * decision's `knownAt` and the later actions are invisible.
   */
  syncFromRepository(pit: PointInTimeRepository, decisionAt: UtcInstant, opts: { snapshotId?: string } = {}): { applied: number; labels: string[] } {
    const kinds = ["SYMBOL_CHANGE", "MERGER", "SPINOFF", "DELISTING"] as const;
    const actions: { action: CorporateAction; id: number; knownAt: UtcInstant }[] = [];
    const labels = new Set<string>();
    for (const kind of kinds) {
      const q = { sourceId: corporateActionSourceId(kind), decisionAt, ...(opts.snapshotId === undefined ? {} : { snapshotId: opts.snapshotId }) };
      const res = pit.asOf(q);
      for (const l of res.labels) labels.add(l);
      for (const row of res.rows) actions.push({ action: corporateActionFromValue(row.value), id: row.id, knownAt: addMs(row.availableAt, res.processingDelayMs) });
    }
    actions.sort((a, b) => {
      const da = actionEffectiveDate(a.action);
      const db = actionEffectiveDate(b.action);
      return da < db ? -1 : da > db ? 1 : a.id - b.id;
    });
    this.db.transaction(() => {
      for (const a of actions) this.applyAction(a.action, corporateActionSourceId(a.action.kind), a.knownAt);
    });
    return { applied: actions.length, labels: [...labels] };
  }

  private close(id: number, effectiveTo: IsoDate, knownAt: UtcInstant): void {
    this.db.prepare("UPDATE entity_symbols SET effective_to = ?, close_known_from = ? WHERE id = ? AND effective_to IS NULL").run(effectiveTo, utc(knownAt), id);
  }
}

function knownAtOf(opts: KnowledgeOpts): string {
  return opts.knownAt === undefined ? ALL_KNOWLEDGE : utc(opts.knownAt);
}
