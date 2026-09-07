import { compareInstants, hashJson, isoDate, nowUtc, utc, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { PointInTimeRepository } from "../data/pit/repository.ts";
import type { AppendResult, PointInTimeObservation, StoredObservation } from "../data/pit/types.ts";

/**
 * Date-effective universe membership (docs/DATA_PROVENANCE_SPEC.md section 6). A universe is a named set
 * with membership snapshots stored as point-in-time observations; a decision reads the newest snapshot
 * that was AVAILABLE at decisionAt, never the current list.
 */
export type UniverseSnapshot = {
  universeId: string;
  /** Stable entity ids (market/entity-map.ts), not tickers. */
  members: string[];
  /** False when the members were chosen with knowledge of their later existence. */
  survivorshipFree: boolean;
  source: string;
  note?: string;
};

export type AddSnapshot = {
  universeId: string;
  effectiveAt: UtcInstant;
  availableAt: UtcInstant;
  members: readonly string[];
  survivorshipFree: boolean;
  source: string;
  note?: string;
  /** Raw artifact hash when the snapshot was parsed from a fetched file; defaults to the hash of the members. */
  rawContentHash?: string;
};

export type MembersAsOf = {
  universeId: string;
  members: string[];
  snapshotEffectiveAt: UtcInstant;
  snapshotAvailableAt: UtcInstant;
  survivorshipFree: boolean;
  observationId: number;
  /** SURVIVORSHIP_BIASED when the snapshot is not survivorship-free, plus any read-path labels. */
  labels: string[];
};

export const UNIVERSE_ADAPTER_VERSION = "1.0.0";
export const UNIVERSE_PARSER_VERSION = "1.0.0";

export function universeSourceId(universeId: string): string {
  return `universe.${universeId}`;
}

/** Labels a run must carry when it used this snapshot. */
export function labelsFor(snapshot: Pick<UniverseSnapshot, "survivorshipFree">): string[] {
  return snapshot.survivorshipFree ? [] : ["SURVIVORSHIP_BIASED"];
}

export class UniverseStore {
  private readonly pit: PointInTimeRepository;
  private readonly clock: () => number;

  constructor(pit: PointInTimeRepository, opts: { clock?: () => number } = {}) {
    this.pit = pit;
    this.clock = opts.clock ?? Date.now;
  }

  addSnapshot(s: AddSnapshot): AppendResult {
    if (s.universeId.length === 0) throw new TypeError("universeId is required");
    const members = [...new Set(s.members)].sort();
    if (members.length === 0) throw new TypeError("a universe snapshot needs at least one member");
    const value: UniverseSnapshot = { universeId: s.universeId, members, survivorshipFree: s.survivorshipFree, source: s.source };
    if (s.note !== undefined) value.note = s.note;
    const obs: PointInTimeObservation<UniverseSnapshot> = {
      sourceId: universeSourceId(s.universeId),
      sourceLocator: `universe/${s.universeId}/${s.effectiveAt}`,
      entityId: s.universeId,
      effectiveAt: utc(s.effectiveAt),
      availableAt: utc(s.availableAt),
      ingestedAt: nowUtc(this.clock),
      rawContentHash: s.rawContentHash ?? `sha256:${hashJson({ universeId: s.universeId, members, survivorshipFree: s.survivorshipFree })}`,
      adapterVersion: UNIVERSE_ADAPTER_VERSION,
      parserVersion: UNIVERSE_PARSER_VERSION,
      value,
      qualityFlags: labelsFor(value),
    };
    return this.pit.append(obs);
  }

  /** The newest snapshot (by effectiveAt, then row id) available at decisionAt, or undefined when none is. */
  membersAsOf(universeId: string, decisionAt: UtcInstant, opts: { snapshotId?: string; processingDelayMs?: number } = {}): MembersAsOf | undefined {
    const res = this.pit.asOf<UniverseSnapshot>({
      sourceId: universeSourceId(universeId),
      entityId: universeId,
      decisionAt,
      ...(opts.snapshotId === undefined ? {} : { snapshotId: opts.snapshotId }),
      ...(opts.processingDelayMs === undefined ? {} : { processingDelayMs: opts.processingDelayMs }),
    });
    let best: StoredObservation<UniverseSnapshot> | undefined;
    for (const row of res.rows) {
      if (row.effectiveAt === undefined) continue;
      if (!best?.effectiveAt) {
        best = row;
        continue;
      }
      const cmp = compareInstants(row.effectiveAt, best.effectiveAt);
      if (cmp > 0 || (cmp === 0 && row.id > best.id)) best = row;
    }
    if (!best?.effectiveAt) return undefined;
    const labels = new Set<string>([...res.labels, ...labelsFor(best.value)]);
    return {
      universeId,
      members: [...best.value.members],
      snapshotEffectiveAt: best.effectiveAt,
      snapshotAvailableAt: best.availableAt,
      survivorshipFree: best.value.survivorshipFree,
      observationId: best.id,
      labels: [...labels],
    };
  }

  /** Every stored snapshot for a universe, regardless of time. Operational use only; never a decision input. */
  history(universeId: string): StoredObservation<UniverseSnapshot>[] {
    return this.pit.all<UniverseSnapshot>(universeSourceId(universeId), universeId);
  }
}

// ---------------------------------------------------------------------------------------------
// The frozen ETF universe (strategies/etf-trend-vol/ALPHA_CHARTER.md section 2.1)
// ---------------------------------------------------------------------------------------------

export const ETF_TREND_VOL_UNIVERSE_ID = "etf_trend_vol_v0";

/** 13 risk ETFs (XLE conditional on the compliance look-through rule) plus BIL as the cash leg. */
export const ETF_TREND_VOL_RISK_ETFS = ["VTI", "QQQ", "IWM", "VTV", "VUG", "XLK", "XLF", "XLV", "XLI", "XLP", "XLU", "XLY", "XLE"] as const;
export const ETF_TREND_VOL_CASH_ETF = "BIL";

/**
 * The charter's frozen list as a snapshot. A frozen list of currently-liquid ETFs is permitted ONLY for the
 * operational track (spec section 6: "a current constituent list may seed only a frozen liquid ETF
 * universe"); it may never be projected backwards as historical membership of any other universe. Every
 * member is among the largest and oldest in its category and nothing launched after 2007 is included, which
 * is why the charter accepts the residual selection bias and marks the snapshot survivorship-free. The
 * effective date is BIL's inception year start; before that the cash leg does not exist and the snapshot is
 * not available.
 */
export function frozenEtfUniverse(opts: { effectiveAt?: IsoDate; availableAt?: UtcInstant } = {}): AddSnapshot {
  const effectiveDate = opts.effectiveAt ?? isoDate("2007-06-01");
  const effectiveAt = utc(`${effectiveDate}T00:00:00Z`);
  return {
    universeId: ETF_TREND_VOL_UNIVERSE_ID,
    effectiveAt,
    availableAt: opts.availableAt ?? effectiveAt,
    members: [...ETF_TREND_VOL_RISK_ETFS, ETF_TREND_VOL_CASH_ETF],
    survivorshipFree: true,
    source: "strategies/etf-trend-vol/ALPHA_CHARTER.md#2.1",
    note: "Frozen operational-track list. XLE is conditional on the compliance look-through rule; XLI and XLP are flagged for look-through.",
  };
}
