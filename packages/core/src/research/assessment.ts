import { z } from "zod";
import { hashJson } from "@blackgold/shared";

/**
 * The Analyst's output contract (docs/PRODUCT_SPEC.md section 6, "Output schema").
 *
 * This is research, not an order. The schema deliberately has no `accountId`, dollar sizing, executable order
 * type, stop price, or `restricted_check`, and it is a STRICT object, so a model that tries to emit any such
 * field fails validation rather than having the field silently ignored (one of the adversarial cases in the
 * spec). Nothing on this type is ever read by the sizing or candidate engines (threat model T-05); the
 * `uncertainty` field is explanatory metadata only and never influences a position size.
 *
 * Validation is fail-closed and layered:
 *   1. strict schema parse (rejects unknown fields and wrong shapes),
 *   2. every cited `sourceId` must resolve to a record in the sealed evidence packet, and
 *   3. the model's `factorsTouched` must match the factor set that code computed deterministically.
 * A failure at any layer is a rejection; the caller abstains for that candidate. An assessment that itself
 * sets `abstain: true` is a valid, expected outcome and short-circuits the citation and factor checks (an
 * abstention makes no claim to stand behind).
 */

export const UNCERTAINTY = ["low", "medium", "high"] as const;
export type Uncertainty = (typeof UNCERTAINTY)[number];

const Citation = z.strictObject({
  sourceId: z.string().min(1),
  fact: z.string().min(1),
});

const Falsifier = z.strictObject({
  condition: z.string().min(1),
  observableBy: z.string().min(1).optional(),
});

/**
 * Strict schema for a raw Analyst response. Kept free of `.refine()` so `z.toJSONSchema` can describe it and
 * so its hash is stable; the semantic rules (abstain needs a reason, a non-abstention needs a thesis, etc.)
 * live in {@link validateAssessment} rather than the shape.
 */
export const ResearchAssessmentSchema = z.strictObject({
  assessmentId: z.string().min(1),
  candidateId: z.string().min(1),
  strategyVersion: z.string().min(1),
  evidenceFor: z.array(Citation),
  evidenceAgainst: z.array(Citation),
  missingEvidence: z.array(z.string().min(1)),
  ontologyTags: z.array(z.string().min(1)),
  factorsTouched: z.array(z.string().min(1)),
  thesis: z.string(),
  strongestDissent: z.string(),
  falsifiers: z.array(Falsifier),
  expectedHorizon: z.string(),
  uncertainty: z.enum(UNCERTAINTY),
  abstain: z.boolean(),
  abstainReason: z.string().min(1).optional(),
});

export type ResearchAssessment = z.infer<typeof ResearchAssessmentSchema>;

/**
 * Stable `sha256:`-prefixed hash of the output schema, in the same form the experiment registry freezes as
 * `model.schema_hash`. Derived from the emitted JSON Schema so any change to the accepted shape changes the
 * hash, which makes it a new strategy version (docs/PRODUCT_SPEC.md model-operations table).
 */
export function assessmentSchemaHash(): string {
  const json = z.toJSONSchema(ResearchAssessmentSchema, { io: "input", target: "draft-2020-12" });
  return `sha256:${hashJson(json)}`;
}

export type AssessmentContext = {
  /** Source ids present in the sealed evidence packet. A citation to anything else fails validation. */
  packetSourceIds: ReadonlySet<string>;
  /** The factor set code computed deterministically for this candidate; the model's claim must match it. */
  deterministicFactors: ReadonlySet<string>;
};

export type AssessmentRejectionCode =
  | "SCHEMA_INVALID"
  | "MISSING_ABSTAIN_REASON"
  | "EMPTY_THESIS"
  | "CITATION_UNRESOLVED"
  | "FACTOR_MISMATCH";

export type AssessmentValidation =
  | { ok: true; abstained: boolean; assessment: ResearchAssessment }
  | { ok: false; code: AssessmentRejectionCode; reason: string };

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Validate a raw model response against the schema and the sealed packet. Returns an accepted assessment
 * (possibly an abstention) or a typed rejection. Never throws on adversarial input: a malformed or hostile
 * response is a rejection the caller turns into a safe abstention, not an exception that could escape.
 */
export function validateAssessment(raw: unknown, ctx: AssessmentContext): AssessmentValidation {
  const parsed = ResearchAssessmentSchema.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    return { ok: false, code: "SCHEMA_INVALID", reason };
  }
  const assessment = parsed.data;

  if (assessment.abstain) {
    if (assessment.abstainReason === undefined) {
      return { ok: false, code: "MISSING_ABSTAIN_REASON", reason: "abstain is true but no abstainReason was given" };
    }
    return { ok: true, abstained: true, assessment };
  }

  // From here the assessment is making a claim, so it must stand behind one.
  if (assessment.thesis.trim() === "") {
    return { ok: false, code: "EMPTY_THESIS", reason: "a non-abstaining assessment must state a thesis" };
  }

  for (const citation of [...assessment.evidenceFor, ...assessment.evidenceAgainst]) {
    if (!ctx.packetSourceIds.has(citation.sourceId)) {
      return { ok: false, code: "CITATION_UNRESOLVED", reason: `cited sourceId "${citation.sourceId}" is not in the sealed packet` };
    }
  }

  const claimed = new Set(assessment.factorsTouched);
  if (!setsEqual(claimed, ctx.deterministicFactors)) {
    const claimedList = [...claimed].sort().join(", ") || "(none)";
    const deterministicList = [...ctx.deterministicFactors].sort().join(", ") || "(none)";
    return {
      ok: false,
      code: "FACTOR_MISMATCH",
      reason: `factorsTouched [${claimedList}] does not match the deterministic classification [${deterministicList}]`,
    };
  }

  return { ok: true, abstained: false, assessment };
}
