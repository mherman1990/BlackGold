import {
  canonicalJson,
  compareInstants,
  deterministicId,
  epochMs,
  hashJson,
  nowUtc,
  utc,
  type Db,
  type UtcInstant,
} from "@blackgold/shared";
import { excludesFromDecisions } from "../quality.ts";
import type { AppendResult, AsOfQuery, AsOfResult, PointInTimeObservation, Snapshot, StoredObservation } from "./types.ts";

/**
 * The single read path for decisions (docs/DATA_PROVENANCE_SPEC.md section 2). Strategy, feature, and
 * evidence-packet code must go through `asOf`; direct table access from those layers is a policy failure.
 *
 * Rows are append-only (triggers enforce it). Corrections are new rows; the old row keeps its hash so any
 * decision made on it stays reproducible.
 */
export class TemporalInversionError extends Error {
  constructor(obs: PointInTimeObservation) {
    super(
      `TEMPORAL_INVERSION: availableAt ${obs.availableAt} precedes observedAt/effectiveAt (${obs.observedAt ?? "-"} / ${obs.effectiveAt ?? "-"}) for ${obs.sourceId} ${obs.sourceLocator}`,
    );
    this.name = "TemporalInversionError";
  }
}

export class UnknownSnapshotError extends Error {
  constructor(id: string) {
    super(`Unknown snapshot ${id}`);
    this.name = "UnknownSnapshotError";
  }
}

/** Default processing delays by source-id prefix (spec section 2). Config may override. */
export const DEFAULT_PROCESSING_DELAY_MS: Readonly<Record<string, number>> = {
  "sec.": 15 * 60_000,
  "market.": 15 * 60_000,
  "alpaca.": 15 * 60_000,
  "fred.": 60 * 60_000,
  "cftc.": 60 * 60_000,
  "treasury.": 60 * 60_000,
  "bls.": 60 * 60_000,
  "bea.": 60 * 60_000,
  "universe.": 0,
  "corporate_action.": 15 * 60_000,
  "test.": 0,
};
const FALLBACK_DELAY_MS = 60 * 60_000;

export function defaultProcessingDelayMs(sourceId: string, overrides: Readonly<Record<string, number>> = {}): number {
  const table = { ...DEFAULT_PROCESSING_DELAY_MS, ...overrides };
  let best: { prefix: string; ms: number } | undefined;
  for (const [prefix, ms] of Object.entries(table)) {
    if (sourceId.startsWith(prefix) && (best === undefined || prefix.length > best.prefix.length)) best = { prefix, ms };
  }
  return best?.ms ?? FALLBACK_DELAY_MS;
}

type Row = Record<string, null | number | bigint | string | Uint8Array>;

export class PointInTimeRepository {
  private readonly db: Db;
  private readonly clock: () => number;
  private readonly delayOverrides: Readonly<Record<string, number>>;

  constructor(db: Db, opts: { clock?: () => number; processingDelayOverrides?: Readonly<Record<string, number>> } = {}) {
    this.db = db;
    this.clock = opts.clock ?? Date.now;
    this.delayOverrides = opts.processingDelayOverrides ?? {};
  }

  /**
   * Append one observation. Identical rows are deduplicated. A row with the same identity
   * (source, locator, entity, effectiveAt, vintageAt, parserVersion) but different content is a
   * DUPLICATE_CONFLICT: both are kept and the new one carries CORRECTED.
   */
  append<T>(obs: PointInTimeObservation<T>): AppendResult {
    validateTimes(obs);
    const valueJson = canonicalJson(obs.value);
    const valueHash = hashJson({ v: obs.value, h: obs.rawContentHash, f: [...obs.qualityFlags].sort() });
    return this.db.transaction(() => {
      const identity = this.db
        .prepare(
          `SELECT id, value_hash FROM observations
           WHERE source_id = ? AND source_locator = ? AND COALESCE(entity_id,'') = ? AND COALESCE(effective_at,'') = ?
             AND COALESCE(vintage_at,'') = ? AND parser_version = ?
           ORDER BY id DESC`,
        )
        .all(obs.sourceId, obs.sourceLocator, obs.entityId ?? "", obs.effectiveAt ?? "", obs.vintageAt ?? "", obs.parserVersion) as {
        id: number;
        value_hash: string;
      }[];
      const same = identity.find((r) => r.value_hash === valueHash);
      if (same) return { id: same.id, deduplicated: true, conflict: false };
      const flags = [...obs.qualityFlags];
      const conflict = identity.length > 0;
      if (conflict && !flags.includes("CORRECTED")) flags.push("CORRECTED");
      const result = this.db
        .prepare(
          `INSERT INTO observations (source_id, source_locator, entity_id, observed_at, effective_at, available_at, vintage_at,
             ingested_at, raw_content_hash, adapter_version, parser_version, value_json, quality_flags_json, value_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          obs.sourceId,
          obs.sourceLocator,
          obs.entityId ?? null,
          obs.observedAt ?? null,
          obs.effectiveAt ?? null,
          obs.availableAt,
          obs.vintageAt ?? null,
          obs.ingestedAt,
          obs.rawContentHash,
          obs.adapterVersion,
          obs.parserVersion,
          valueJson,
          JSON.stringify(flags.sort()),
          valueHash,
        );
      return { id: Number(result.lastInsertRowid), deduplicated: false, conflict };
    });
  }

  appendMany<T>(observations: readonly PointInTimeObservation<T>[]): AppendResult[] {
    return this.db.transaction(() => observations.map((o) => this.append(o)));
  }

  /**
   * The decision-time query. Returns rows with availableAt + delay <= decisionAt (and, for revisable
   * sources, only the latest vintage that itself satisfies the rule), excluding rows whose quality codes
   * bar them from decisions. With a zero delay the result is labelled OPTIMISTIC_DELAY.
   */
  asOf<T = unknown>(q: AsOfQuery): AsOfResult<T> {
    const delay = q.processingDelayMs ?? defaultProcessingDelayMs(q.sourceId, this.delayOverrides);
    if (delay < 0) throw new RangeError("processingDelayMs must be >= 0");
    const cutoff = utc(epochMs(q.decisionAt) - delay);
    const maxId = q.snapshotId === undefined ? Number.MAX_SAFE_INTEGER : this.snapshot(q.snapshotId).maxObservationId;
    const params: (string | number)[] = [q.sourceId, cutoff, cutoff, maxId];
    let sql = `SELECT * FROM observations
      WHERE source_id = ? AND available_at <= ? AND (vintage_at IS NULL OR vintage_at <= ?) AND id <= ?`;
    if (q.entityId !== undefined) {
      sql += " AND entity_id = ?";
      params.push(q.entityId);
    }
    if (q.effectiveFrom !== undefined) {
      sql += " AND effective_at >= ?";
      params.push(q.effectiveFrom);
    }
    if (q.effectiveTo !== undefined) {
      sql += " AND effective_at <= ?";
      params.push(q.effectiveTo);
    }
    sql += " ORDER BY id";
    const candidates = (this.db.prepare(sql).all(...params) as Row[]).map((r) => rowToObservation<T>(r));

    // Collapse: revisable rows (vintageAt set) to one per (entity, effectiveAt) with the greatest admissible
    // vintage; non-revisable rows to one per (entity, effectiveAt, locator) where the latest row wins, so a
    // correction supersedes the original once the correction itself is available.
    const chosen = new Map<string, StoredObservation<T>>();
    for (const row of candidates) {
      if (excludesFromDecisions(row.qualityFlags)) continue;
      const key =
        row.vintageAt === undefined
          ? `${row.entityId ?? ""}|${row.effectiveAt ?? ""}|${row.sourceLocator}`
          : `${row.entityId ?? ""}|${row.effectiveAt ?? ""}`;
      const prev = chosen.get(key);
      if (!prev) {
        chosen.set(key, row);
        continue;
      }
      const cmp = compareVintage(row, prev);
      if (cmp > 0 || (cmp === 0 && row.id > prev.id)) chosen.set(key, row);
    }
    const rows = [...chosen.values()].sort((a, b) => a.id - b.id);
    const labels: string[] = [];
    if (delay === 0 && defaultProcessingDelayMs(q.sourceId, this.delayOverrides) > 0) labels.push("OPTIMISTIC_DELAY");
    return { rows, labels, processingDelayMs: delay };
  }

  /** All rows for a source, regardless of time. Operational and quality use only; never a decision input. */
  all<T = unknown>(sourceId: string, entityId?: string): StoredObservation<T>[] {
    const rows =
      entityId === undefined
        ? this.db.prepare("SELECT * FROM observations WHERE source_id = ? ORDER BY id").all(sourceId)
        : this.db.prepare("SELECT * FROM observations WHERE source_id = ? AND entity_id = ? ORDER BY id").all(sourceId, entityId);
    return (rows as Row[]).map((r) => rowToObservation<T>(r));
  }

  byId<T = unknown>(id: number): StoredObservation<T> | undefined {
    const row = this.db.prepare("SELECT * FROM observations WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToObservation<T>(row) : undefined;
  }

  count(sourceId?: string): number {
    const row = (
      sourceId === undefined
        ? this.db.prepare("SELECT count(*) AS n FROM observations").get()
        : this.db.prepare("SELECT count(*) AS n FROM observations WHERE source_id = ?").get(sourceId)
    ) as { n: number };
    return row.n;
  }

  /** Newest availableAt for a source: the input to STALE checks. */
  latestAvailableAt(sourceId: string, entityId?: string): UtcInstant | undefined {
    const row = (
      entityId === undefined
        ? this.db.prepare("SELECT max(available_at) AS m FROM observations WHERE source_id = ?").get(sourceId)
        : this.db.prepare("SELECT max(available_at) AS m FROM observations WHERE source_id = ? AND entity_id = ?").get(sourceId, entityId)
    ) as { m: string | null };
    return row.m === null ? undefined : utc(row.m);
  }

  /** Freeze the current row set under a reproducible id. Queries scoped to the snapshot ignore later rows. */
  createSnapshot(dataset: string, description: string): Snapshot {
    return this.db.transaction(() => {
      const max = (this.db.prepare("SELECT COALESCE(max(id), 0) AS m FROM observations").get() as { m: number }).m;
      const createdAt = nowUtc(this.clock);
      const snapshotId = deterministicId(`snap_${dataset}`, max, createdAt);
      this.db
        .prepare("INSERT INTO pit_snapshots (snapshot_id, dataset, description, created_at, max_observation_id) VALUES (?, ?, ?, ?, ?)")
        .run(snapshotId, dataset, description, createdAt, max);
      return { snapshotId, dataset, description, createdAt, maxObservationId: max };
    });
  }

  snapshot(snapshotId: string): Snapshot {
    const row = this.db.prepare("SELECT * FROM pit_snapshots WHERE snapshot_id = ?").get(snapshotId) as Row | undefined;
    if (!row) throw new UnknownSnapshotError(snapshotId);
    return {
      snapshotId,
      dataset: String(row["dataset"]),
      description: String(row["description"]),
      createdAt: utc(String(row["created_at"])),
      maxObservationId: Number(row["max_observation_id"]),
    };
  }

  snapshots(): Snapshot[] {
    return (this.db.prepare("SELECT * FROM pit_snapshots ORDER BY created_at").all() as Row[]).map((row) => ({
      snapshotId: String(row["snapshot_id"]),
      dataset: String(row["dataset"]),
      description: String(row["description"]),
      createdAt: utc(String(row["created_at"])),
      maxObservationId: Number(row["max_observation_id"]),
    }));
  }
}

function validateTimes(obs: PointInTimeObservation): void {
  const available = utc(obs.availableAt);
  if (obs.observedAt !== undefined && compareInstants(available, utc(obs.observedAt)) < 0) throw new TemporalInversionError(obs);
  if (obs.effectiveAt !== undefined && compareInstants(available, utc(obs.effectiveAt)) < 0) throw new TemporalInversionError(obs);
  utc(obs.ingestedAt);
  if (obs.vintageAt !== undefined) utc(obs.vintageAt);
  if (!/^sha256:[0-9a-f]{64}$/.test(obs.rawContentHash)) throw new TypeError(`rawContentHash must be sha256:<64 hex>, got ${obs.rawContentHash}`);
  if (obs.sourceId.length === 0 || obs.sourceLocator.length === 0) throw new TypeError("sourceId and sourceLocator are required");
}

function compareVintage(a: StoredObservation, b: StoredObservation): number {
  if (a.vintageAt === undefined && b.vintageAt === undefined) return 0;
  if (a.vintageAt === undefined) return -1;
  if (b.vintageAt === undefined) return 1;
  return compareInstants(a.vintageAt, b.vintageAt);
}

function optInstant(v: unknown): UtcInstant | undefined {
  return typeof v === "string" ? utc(v) : undefined;
}

function rowToObservation<T>(r: Row): StoredObservation<T> {
  const obs: StoredObservation<T> = {
    id: Number(r["id"]),
    sourceId: String(r["source_id"]),
    sourceLocator: String(r["source_locator"]),
    availableAt: utc(String(r["available_at"])),
    ingestedAt: utc(String(r["ingested_at"])),
    rawContentHash: String(r["raw_content_hash"]),
    adapterVersion: String(r["adapter_version"]),
    parserVersion: String(r["parser_version"]),
    value: JSON.parse(String(r["value_json"])) as T,
    qualityFlags: JSON.parse(String(r["quality_flags_json"])) as string[],
  };
  const entity = r["entity_id"];
  if (typeof entity === "string") obs.entityId = entity;
  const observed = optInstant(r["observed_at"]);
  if (observed) obs.observedAt = observed;
  const effective = optInstant(r["effective_at"]);
  if (effective) obs.effectiveAt = effective;
  const vintage = optInstant(r["vintage_at"]);
  if (vintage) obs.vintageAt = vintage;
  return obs;
}
