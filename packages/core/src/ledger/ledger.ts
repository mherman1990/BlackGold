import {
  canonicalJson,
  computeEventHash,
  GENESIS_HASH,
  nowUtc,
  sha256Hex,
  utc,
  verifyEventChain,
  addDays,
  type ChainVerdict,
  type Db,
  type IsoDate,
  type LedgerEvent,
  type Sha256Hex,
  type UtcInstant,
} from "@blackgold/shared";

export type LedgerSeal = {
  date: IsoDate;
  firstSeq: number | null;
  lastSeq: number | null;
  rootHash: Sha256Hex;
  sealedAt: UtcInstant;
};

export class SealMismatchError extends Error {
  constructor(date: IsoDate, existing: Sha256Hex, computed: Sha256Hex) {
    super(`Ledger seal for ${date} already exists with root ${existing}; recomputed root is ${computed}`);
    this.name = "SealMismatchError";
  }
}

type EventRow = { seq: number; at: string; kind: string; payload: string; prev_hash: string; hash: string };
type SealRow = { date: string; first_seq: number | null; last_seq: number | null; root_hash: string; sealed_at: string };

/**
 * Append-only, hash-chained event ledger over SQLite. Tamper-evident, not immutable: the trigger blocks
 * UPDATE/DELETE through SQL, and verifyChain() detects any edit made around it.
 * Payloads are stored as canonical JSON so equal values hash equally.
 */
export class Ledger {
  private readonly db: Db;
  private readonly clock: () => number;

  constructor(db: Db, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }

  append(kind: string, payload: unknown, at: UtcInstant = nowUtc(this.clock)): LedgerEvent {
    if (kind.length === 0) throw new TypeError("ledger event kind must be non-empty");
    const atNormalized = utc(at);
    return this.db.transaction(() => {
      const last = this.db.prepare("SELECT seq, hash FROM ledger_events ORDER BY seq DESC LIMIT 1").get() as
        | { seq: number; hash: string }
        | undefined;
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = (last?.hash ?? GENESIS_HASH) as Sha256Hex;
      const normalized: unknown = JSON.parse(canonicalJson(payload ?? null));
      const partial = { seq, at: atNormalized, kind, payload: normalized, prevHash };
      const hash = computeEventHash(partial);
      this.db
        .prepare("INSERT INTO ledger_events (seq, at, kind, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(seq, atNormalized, kind, canonicalJson(normalized), prevHash, hash);
      return { ...partial, hash };
    });
  }

  /** Events with fromSeq <= seq <= toSeq, ascending. */
  events(fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER): LedgerEvent[] {
    const rows = this.db
      .prepare("SELECT seq, at, kind, payload, prev_hash, hash FROM ledger_events WHERE seq >= ? AND seq <= ? ORDER BY seq")
      .all(fromSeq, toSeq) as EventRow[];
    return rows.map(rowToEvent);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM ledger_events").get() as { n: number };
    return row.n;
  }

  verifyChain(): ChainVerdict {
    return verifyEventChain(this.events());
  }

  /** Events whose `at` falls on the given UTC calendar date, ascending. */
  eventsOnDate(date: IsoDate): LedgerEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, at, kind, payload, prev_hash, hash FROM ledger_events WHERE at >= ? AND at < ? ORDER BY seq",
      )
      .all(`${date}T00:00:00.000Z`, `${addDays(date, 1)}T00:00:00.000Z`) as EventRow[];
    return rows.map(rowToEvent);
  }

  /** Root hash for a UTC date: sha256 of the concatenated event hashes (sha256 of "" when the day is empty). */
  computeDailyRoot(date: IsoDate): { rootHash: Sha256Hex; firstSeq: number | null; lastSeq: number | null } {
    const events = this.eventsOnDate(date);
    const rootHash = sha256Hex(events.map((e) => e.hash).join(""));
    const first = events[0];
    const last = events[events.length - 1];
    return { rootHash, firstSeq: first?.seq ?? null, lastSeq: last?.seq ?? null };
  }

  /**
   * Seal a UTC date. Idempotent: re-sealing with the same root is a no-op and returns the existing seal.
   * A different root means the day's events changed after sealing, which is a tamper signal: throws.
   */
  sealDaily(date: IsoDate, sealedAt: UtcInstant = nowUtc(this.clock)): LedgerSeal {
    return this.db.transaction(() => {
      const computed = this.computeDailyRoot(date);
      const existing = this.seal(date);
      if (existing) {
        if (existing.rootHash !== computed.rootHash) throw new SealMismatchError(date, existing.rootHash, computed.rootHash);
        return existing;
      }
      this.db
        .prepare("INSERT INTO ledger_seals (date, first_seq, last_seq, root_hash, sealed_at) VALUES (?, ?, ?, ?, ?)")
        .run(date, computed.firstSeq, computed.lastSeq, computed.rootHash, sealedAt);
      return { date, ...computed, sealedAt };
    });
  }

  seal(date: IsoDate): LedgerSeal | undefined {
    const row = this.db.prepare("SELECT * FROM ledger_seals WHERE date = ?").get(date) as SealRow | undefined;
    return row ? rowToSeal(row) : undefined;
  }

  latestSeal(): LedgerSeal | undefined {
    const row = this.db.prepare("SELECT * FROM ledger_seals ORDER BY date DESC LIMIT 1").get() as SealRow | undefined;
    return row ? rowToSeal(row) : undefined;
  }

  seals(): LedgerSeal[] {
    const rows = this.db.prepare("SELECT * FROM ledger_seals ORDER BY date").all() as SealRow[];
    return rows.map(rowToSeal);
  }

  /** Recompute every sealed day's root and compare with the stored seal. */
  verifySeals(): { ok: boolean; mismatches: IsoDate[] } {
    const mismatches: IsoDate[] = [];
    for (const s of this.seals()) {
      if (this.computeDailyRoot(s.date).rootHash !== s.rootHash) mismatches.push(s.date);
    }
    return { ok: mismatches.length === 0, mismatches };
  }
}

function rowToEvent(r: EventRow): LedgerEvent {
  return {
    seq: r.seq,
    at: r.at as UtcInstant,
    kind: r.kind,
    payload: JSON.parse(r.payload) as unknown,
    prevHash: r.prev_hash as Sha256Hex,
    hash: r.hash as Sha256Hex,
  };
}

function rowToSeal(r: SealRow): LedgerSeal {
  return {
    date: r.date as IsoDate,
    firstSeq: r.first_seq,
    lastSeq: r.last_seq,
    rootHash: r.root_hash as Sha256Hex,
    sealedAt: r.sealed_at as UtcInstant,
  };
}
