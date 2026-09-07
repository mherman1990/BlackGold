import type { Arm } from "@blackgold/shared";
import type { ResearchAssessment } from "../research/assessment.ts";

/**
 * Arm orchestration for the runtime-LLM overlay (docs/EXPERIMENT_PROTOCOL.md section 6; PRODUCT_SPEC section 6).
 *
 * The protocol's non-interaction rules are enforced here by TYPE, not by convention:
 *  - C1 is produced from B1's *frozen* selected list and can only ever REMOVE a name from it (the result is a
 *    filter of `b1Selected`), so the LLM can never add exposure B1 did not take. This mirrors "compliance can
 *    only remove, never add" and means a hostile or wrong model reduces risk at worst, never increases it.
 *  - The overlay receives no dollar size and no account; model confidence/uncertainty never reaches sizing.
 *    C1 changes membership only, and the deterministic constructor sizes the resulting set downstream.
 *  - D1 is built from assessments alone and is given no B1 or C1 input, so it cannot see their decisions.
 *  - An abstention or a failed/degraded call never vetoes, so with no usable model output C1 degrades exactly
 *    to B1 (threat model T-07), and the ledger records the degrade.
 *
 * Any historical replay is contaminated (the model may know how the story ended), so every arm selection made
 * in HISTORICAL_REPLAY mode carries `HISTORICAL_REPLAY_CONTAMINATED`. Contaminated selections diagnose
 * behaviour; they are never primary promotion evidence. A real C1/D1 run is prospective (Phase 5 shadow).
 */

export const RUN_MODE = ["HISTORICAL_REPLAY", "PROSPECTIVE"] as const;
export type RunMode = (typeof RUN_MODE)[number];

export const CONTAMINATION_LABEL = "HISTORICAL_REPLAY_CONTAMINATED";

/** What the overlay sees for one candidate. Never carries a size or an account. */
export type OverlayAssessment =
  | { kind: "assessed"; assessment: ResearchAssessment }
  /** The model abstained, or the call failed/timed out/was over budget - the overlay treats these the same. */
  | { kind: "abstained" };

/**
 * A preregistered overlay rule. It answers only "keep this candidate B1 already selected?", so it is
 * subtractive by type. The concrete rule for a strategy comes from its charter; the default below is the
 * fail-safe used until a charter declares one.
 */
export type OverlayRule = (input: { candidateId: string; assessment: OverlayAssessment }) => boolean;

/**
 * Fail-safe default rule. Keeps a candidate unless the model returned a valid, non-abstaining assessment whose
 * evidence is purely net-negative (something against it, nothing for it) - a structural, subtractive signal
 * that reads no confidence value. Abstentions and failed calls always keep, so C1 degrades to B1.
 */
export function subtractiveVetoRule(input: { candidateId: string; assessment: OverlayAssessment }): boolean {
  if (input.assessment.kind !== "assessed") return true;
  const a = input.assessment.assessment;
  if (a.abstain) return true;
  const netNegative = a.evidenceAgainst.length > 0 && a.evidenceFor.length === 0;
  return !netNegative;
}

export function labelsForMode(runMode: RunMode): string[] {
  return runMode === "HISTORICAL_REPLAY" ? [CONTAMINATION_LABEL] : [];
}

export type ArmSelection = {
  arm: Arm;
  selected: string[];
  runMode: RunMode;
  /** Includes CONTAMINATION_LABEL when the mode is HISTORICAL_REPLAY. */
  labels: string[];
};

export type OverlayInput = {
  /** B1's frozen selected list. Read-only: the overlay never mutates it or feeds C1 back into B1. */
  b1Selected: readonly string[];
  assessments: ReadonlyMap<string, OverlayAssessment>;
  rule: OverlayRule;
  runMode: RunMode;
};

/**
 * Produce the C1 selection by applying the preregistered subtractive rule to B1's frozen list. The result is
 * always a subset of `b1Selected`, in the same order; a missing assessment is treated as an abstention (keep).
 */
export function applyOverlay(input: OverlayInput): ArmSelection {
  const selected = input.b1Selected.filter((candidateId) => {
    const assessment = input.assessments.get(candidateId) ?? ({ kind: "abstained" } as const);
    return input.rule({ candidateId, assessment });
  });
  return { arm: "C1_LLM_OVERLAY", selected: [...selected], runMode: input.runMode, labels: labelsForMode(input.runMode) };
}

export type ShadowInput = {
  /** Every candidate the model assessed. D1 is given no B1 or C1 decision, by construction of this type. */
  assessments: ReadonlyMap<string, OverlayAssessment>;
  runMode: RunMode;
};

/**
 * The D1 LLM-only diagnostic selection: names with a valid, non-abstaining assessment whose evidence is net
 * positive (something for it, nothing against). It sees no B1 or C1 decision. Never automatically eligible;
 * a diagnostic portfolio only.
 */
export function shadowSelection(input: ShadowInput): ArmSelection {
  const selected: string[] = [];
  for (const [candidateId, assessment] of input.assessments) {
    if (assessment.kind !== "assessed") continue;
    const a = assessment.assessment;
    if (a.abstain) continue;
    if (a.evidenceFor.length > 0 && a.evidenceAgainst.length === 0) selected.push(candidateId);
  }
  return { arm: "D1_LLM_ONLY_SHADOW", selected, runMode: input.runMode, labels: labelsForMode(input.runMode) };
}
