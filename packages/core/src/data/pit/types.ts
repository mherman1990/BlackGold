import type { Sha256Hex, UtcInstant } from "@blackgold/shared";

/**
 * The point-in-time observation contract (docs/DATA_PROVENANCE_SPEC.md section 1). Every normalized
 * record any adapter produces has this shape. `availableAt` is the only field a decision may filter on.
 */
export type PointInTimeObservation<T = unknown> = {
  sourceId: string;
  sourceLocator: string;
  entityId?: string;
  observedAt?: UtcInstant;
  effectiveAt?: UtcInstant;
  availableAt: UtcInstant;
  vintageAt?: UtcInstant;
  ingestedAt: UtcInstant;
  /** "sha256:<hex>" of the raw artifact the record was parsed from. */
  rawContentHash: string;
  adapterVersion: string;
  parserVersion: string;
  value: T;
  qualityFlags: string[];
};

/** A stored observation: the contract plus its immutable row id. */
export type StoredObservation<T = unknown> = PointInTimeObservation<T> & { id: number };

export type AppendResult = {
  id: number;
  /** True when an identical row already existed and no new row was written. */
  deduplicated: boolean;
  /** True when a row with the same identity but different content existed; the new row carries CORRECTED. */
  conflict: boolean;
};

export type AsOfQuery = {
  sourceId: string;
  entityId?: string;
  /** The decision instant. Rows must satisfy availableAt + processingDelay <= decisionAt. */
  decisionAt: UtcInstant;
  /** Overrides the per-source default. Zero labels the result OPTIMISTIC_DELAY. */
  processingDelayMs?: number;
  /** Restrict to rows that existed when the snapshot was created. */
  snapshotId?: string;
  /** Optional effective-period window (inclusive) on effectiveAt. */
  effectiveFrom?: UtcInstant;
  effectiveTo?: UtcInstant;
};

export type AsOfResult<T = unknown> = {
  rows: StoredObservation<T>[];
  /** Labels the caller must attach to any run that used this result. */
  labels: string[];
  processingDelayMs: number;
};

export type Snapshot = {
  snapshotId: string;
  dataset: string;
  description: string;
  createdAt: UtcInstant;
  maxObservationId: number;
};

export function prefixedHash(hex: Sha256Hex | string): string {
  return hex.startsWith("sha256:") ? hex : `sha256:${hex}`;
}

export function stripHashPrefix(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}
