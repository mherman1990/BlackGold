/**
 * Data-quality reason codes (docs/DATA_PROVENANCE_SPEC.md section 8). Every code has a severity and a
 * decision effect. Unknown, stale, conflicting, or unverifiable state fails closed for new risk.
 */
export const QUALITY_CODES = [
  "AVAILABLE_AT_ESTIMATED",
  "AFTER_HOURS_ACCEPTANCE",
  "LATE_FILING",
  "AMENDED",
  "RELEASE_DELAYED",
  "STALE",
  "STALE_BAR",
  "GAP",
  "OUTLIER",
  "SCHEMA_DRIFT",
  "TEMPORAL_INVERSION",
  "DUPLICATE_CONFLICT",
  "CORRECTED",
  "ARTIFACT_MISSING",
  "UNKNOWN_ENTITY",
  "SURVIVORSHIP_BIASED",
  "OPTIMISTIC_DELAY",
  "FORWARD_DATED_REPORT",
] as const;
export type QualityCode = (typeof QUALITY_CODES)[number];

export type QualitySeverity = "info" | "warn" | "error" | "label";

export type QualityRule = {
  severity: QualitySeverity;
  /** Whether a row carrying this code may still be read by a decision query. */
  decisionAllowed: boolean;
  /** Whether a run carrying this code may ever be cited as promotion evidence. */
  promotionEvidenceAllowed: boolean;
};

export const QUALITY_RULES: Readonly<Record<QualityCode, QualityRule>> = {
  AVAILABLE_AT_ESTIMATED: { severity: "info", decisionAllowed: true, promotionEvidenceAllowed: true },
  AFTER_HOURS_ACCEPTANCE: { severity: "info", decisionAllowed: true, promotionEvidenceAllowed: true },
  LATE_FILING: { severity: "info", decisionAllowed: true, promotionEvidenceAllowed: true },
  AMENDED: { severity: "warn", decisionAllowed: true, promotionEvidenceAllowed: true },
  RELEASE_DELAYED: { severity: "warn", decisionAllowed: true, promotionEvidenceAllowed: true },
  STALE: { severity: "warn", decisionAllowed: false, promotionEvidenceAllowed: true },
  STALE_BAR: { severity: "warn", decisionAllowed: true, promotionEvidenceAllowed: true },
  GAP: { severity: "warn", decisionAllowed: true, promotionEvidenceAllowed: true },
  OUTLIER: { severity: "warn", decisionAllowed: true, promotionEvidenceAllowed: true },
  SCHEMA_DRIFT: { severity: "error", decisionAllowed: false, promotionEvidenceAllowed: false },
  TEMPORAL_INVERSION: { severity: "error", decisionAllowed: false, promotionEvidenceAllowed: false },
  DUPLICATE_CONFLICT: { severity: "error", decisionAllowed: true, promotionEvidenceAllowed: true },
  CORRECTED: { severity: "warn", decisionAllowed: true, promotionEvidenceAllowed: true },
  ARTIFACT_MISSING: { severity: "error", decisionAllowed: false, promotionEvidenceAllowed: false },
  UNKNOWN_ENTITY: { severity: "error", decisionAllowed: false, promotionEvidenceAllowed: false },
  SURVIVORSHIP_BIASED: { severity: "label", decisionAllowed: true, promotionEvidenceAllowed: false },
  OPTIMISTIC_DELAY: { severity: "label", decisionAllowed: true, promotionEvidenceAllowed: false },
  // Info rather than warn: the row is fully usable and nothing is lost. The filing's own reportDate stays
  // in the value, and the flag exists so the substitution is visible in the store rather than silent.
  FORWARD_DATED_REPORT: { severity: "info", decisionAllowed: true, promotionEvidenceAllowed: true },
};

export function isQualityCode(s: string): s is QualityCode {
  return (QUALITY_CODES as readonly string[]).includes(s);
}

/** Codes that make a run exploratory only. The registry refuses promotion evidence when any is present. */
export function blocksPromotionEvidence(codes: readonly string[]): QualityCode[] {
  return codes.filter(isQualityCode).filter((c) => !QUALITY_RULES[c].promotionEvidenceAllowed);
}

/** Codes that exclude a row from decision queries. */
export function excludesFromDecisions(codes: readonly string[]): boolean {
  return codes.filter(isQualityCode).some((c) => !QUALITY_RULES[c].decisionAllowed);
}
