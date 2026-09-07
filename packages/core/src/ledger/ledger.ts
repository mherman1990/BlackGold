import {
  canonicalJson,
  computeEventHash,
  GENESIS_HASH,
  nowUtc,
  sha256Hex,
  utc,
  verifyEventChain,
  addDays,
  dateOfInstantInZone,
  isoDate,
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

/**
 * An append whose `at` falls on a date that is already sealed.
 *
 * Refused rather than accepted, because accepting it is unrecoverable: the day's root would no longer match
 * its seal, `verifySeals()` would fail for the rest of the database's life, and there is no repair path -
 * `ledger_seals` carries no-UPDATE and no-DELETE triggers and `sealDaily` throws on a changed root. Failing
 * the write loses one event and keeps the integrity record intact; allowing it keeps the event and destroys
 * the record. The realistic cause is a caller that captured a timestamp, did hours of work, and appended with
 * the stale value - `runIngest` did exactly that until its events were moved to a completion stamp - so the
 * error names the date and the kind to make the offending call site obvious.
 */
export class SealedDateAppendError extends Error {
  constructor(date: IsoDate, kind: string) {
    super(
      `Refusing to append a "${kind}" event dated ${date}: that day is already sealed. ` +
        `A ledger event must be stamped when it happens, not with a timestamp captured earlier.`,
    );
    this.name = "SealedDateAppendError";
  }
}

/**
 * Days left open before the seal job will touch them, beyond the current day.
 *
 * Sealing a day is irreversible: `ledger_seals` carries no-UPDATE and no-DELETE triggers, and any event that
 * later lands on a sealed date is refused (`SealedDateAppendError`). So the seal must not run so close behind
 * the clock that it races a job still in flight. A caller that captures a timestamp and appends with it after
 * a long piece of work is the realistic case; `runIngest` stamped `ingest.completed` with an instant captured
 * before hours of rate-limited fetching until that was fixed at the source, and the next such caller will not
 * arrive announced.
 *
 * One full grace day means an event whose timestamp is up to two days stale still lands safely. Raising this
 * only delays tamper-evidence; lowering it to zero reintroduces the race the append guard then has to catch.
 */
export const SEAL_GRACE_DAYS = 1;

/** Newest UTC date the seal job may seal at `now`: yesterday, less the grace window. */
export function sealThroughDate(now: UtcInstant): IsoDate {
  return addDays(dateOfInstantInZone(now, "UTC"), -(1 + SEAL_GRACE_DAYS));
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
      // Fail closed on a backdated append into a sealed day: it would break that day's root permanently and
      // no repair path exists. See SealedDateAppendError.
      const atDate = isoDate(atNormalized.slice(0, 10));
      if (this.seal(atDate)) throw new SealedDateAppendError(atDate, kind);
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

  /**
   * Verify only the chain segment after the last sealed event, anchored on that event's stored hash.
   *
   * The health probe runs on every request (the container healthcheck hits it every 60 s); rehashing the whole
   * ledger there is O(all events) and becomes a restart-loop-class cost once the ledger carries real volume
   * (`HANDOFF.md` §7). The sealed prefix is already frozen - each sealed day's root is fixed in `ledger_seals`
   * and re-checked by the scheduled full verification (`verifyChain` + `verifySeals`) - so the probe only needs
   * to prove the *unsealed tail* is intact and still linked to that frozen prefix. A tamper in the tail is
   * caught here every call; a tamper in the sealed prefix is caught by the scheduled full check, not this one,
   * so the detection guarantee is unchanged and only its latency for the sealed region grows from one probe to
   * one schedule. When nothing is sealed yet the whole chain is the tail, so this degrades to a full
   * `verifyChain`.
   */
  verifyChainSinceLastSeal(): ChainVerdict {
    const anchorSeq = this.maxSealedSeq();
    if (anchorSeq === null) return this.verifyChain();
    const anchor = this.db.prepare("SELECT hash FROM ledger_events WHERE seq = ?").get(anchorSeq) as { hash: string } | undefined;
    // The anchor is a sealed event; if it is gone, a sealed event was deleted - a tamper the tail check below
    // cannot see, because there is then nothing to anchor the tail to.
    if (!anchor) return { ok: false, brokenAt: anchorSeq, reason: "sealed anchor event missing" };
    const tail = this.events(anchorSeq + 1);
    const head = tail[0];
    if (head === undefined) return { ok: true };
    // Contiguity across the seal boundary: the first unsealed event must be the anchor's immediate successor,
    // or an event between them was removed.
    if (head.seq !== anchorSeq + 1) return { ok: false, brokenAt: anchorSeq + 1, reason: `sequence gap after last seal at ${anchorSeq}` };
    return verifyEventChain(tail, anchor.hash as Sha256Hex);
  }

  /** Highest event sequence covered by any seal, or null when no seal covers an event. */
  private maxSealedSeq(): number | null {
    const row = this.db.prepare("SELECT MAX(last_seq) AS n FROM ledger_seals WHERE last_seq IS NOT NULL").get() as { n: number | null };
    return row.n;
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

  /**
   * Distinct UTC dates that carry at least one event, ascending.
   *
   * Read-only. Exists so a caller can find the days that still need sealing without scanning every event:
   * a day with no events has an empty root and nothing to protect, so only these dates matter.
   */
  eventDates(): IsoDate[] {
    const rows = this.db.prepare("SELECT DISTINCT substr(at, 1, 10) AS d FROM ledger_events ORDER BY d").all() as { d: string }[];
    return rows.map((r) => isoDate(r.d));
  }

  /**
   * Every UTC date at or before `throughDate` that has events but no seal, ascending.
   *
   * This is what makes catch-up sealing possible. The scheduler records a run it could not perform as
   * `missed` rather than running it late, so a Pi that was powered off for three days would otherwise leave
   * those days permanently unsealed. Sealing the whole unsealed backlog on the next successful run closes
   * that hole, and is safe because `sealDaily` is idempotent.
   */
  unsealedDates(throughDate: IsoDate): IsoDate[] {
    const sealed = new Set(this.seals().map((s) => s.date));
    return this.eventDates().filter((d) => d <= throughDate && !sealed.has(d));
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
