import { describe, expect, it } from "vitest";
import {
  assessmentSchemaHash,
  ResearchAssessmentSchema,
  validateAssessment,
  type AssessmentContext,
  type ResearchAssessment,
} from "../src/research/assessment.ts";

/** A complete, valid, non-abstaining assessment whose citations and factors match the context below. */
function goodAssessment(overrides: Partial<ResearchAssessment> = {}): ResearchAssessment {
  return {
    assessmentId: "asmt_1",
    candidateId: "XLK",
    strategyVersion: "etf-trend-vol@1",
    evidenceFor: [{ sourceId: "sec.0001", fact: "revenue up" }],
    evidenceAgainst: [{ sourceId: "fred.DGS10", fact: "rates rising" }],
    missingEvidence: ["no current-quarter guidance"],
    ontologyTags: ["momentum"],
    factorsTouched: ["momentum", "trend"],
    thesis: "trend intact",
    strongestDissent: "rates could compress the multiple",
    falsifiers: [{ condition: "20d return < -8%", observableBy: "price" }],
    expectedHorizon: "20 sessions",
    uncertainty: "medium",
    abstain: false,
    ...overrides,
  };
}

function context(overrides: Partial<AssessmentContext> = {}): AssessmentContext {
  return {
    packetSourceIds: new Set(["sec.0001", "fred.DGS10"]),
    deterministicFactors: new Set(["momentum", "trend"]),
    ...overrides,
  };
}

describe("ResearchAssessment schema and validation", () => {
  it("accepts a complete, well-cited, factor-matching assessment", () => {
    const result = validateAssessment(goodAssessment(), context());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.abstained).toBe(false);
  });

  it("accepts an abstention with a reason and skips citation/factor checks", () => {
    const abstained = {
      ...goodAssessment(),
      abstain: true,
      abstainReason: "packet too thin to assess",
      // deliberately hostile fields that would fail the claim checks, proving abstain short-circuits them:
      evidenceFor: [{ sourceId: "not-in-packet", fact: "x" }],
      factorsTouched: ["value"],
      thesis: "",
    };
    const result = validateAssessment(abstained, context());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.abstained).toBe(true);
  });

  it("rejects an abstention with no reason", () => {
    const result = validateAssessment({ ...goodAssessment(), abstain: true }, context());
    expect(result).toMatchObject({ ok: false, code: "MISSING_ABSTAIN_REASON" });
  });

  it("rejects an out-of-schema field: accountId", () => {
    const result = validateAssessment({ ...goodAssessment(), accountId: "acct-1" }, context());
    expect(result).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
  });

  it("rejects an out-of-schema field: dollar sizing / order type / stop price", () => {
    for (const field of [{ sizeUsd: "1000.00" }, { orderType: "market" }, { stopPrice: "10.00" }, { restricted_check: true }]) {
      const result = validateAssessment({ ...goodAssessment(), ...field }, context());
      expect(result).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
    }
  });

  it("rejects a missing required field", () => {
    const { thesis: _drop, ...withoutThesis } = goodAssessment();
    const result = validateAssessment(withoutThesis, context());
    expect(result).toMatchObject({ ok: false, code: "SCHEMA_INVALID" });
  });

  it("rejects a citation that does not resolve to a packet source id", () => {
    const bad = goodAssessment({ evidenceFor: [{ sourceId: "sec.9999", fact: "made up" }] });
    const result = validateAssessment(bad, context());
    expect(result).toMatchObject({ ok: false, code: "CITATION_UNRESOLVED" });
  });

  it("rejects an unresolved citation on the against side too", () => {
    const bad = goodAssessment({ evidenceAgainst: [{ sourceId: "phantom", fact: "x" }] });
    expect(validateAssessment(bad, context())).toMatchObject({ ok: false, code: "CITATION_UNRESOLVED" });
  });

  it("rejects a factorsTouched set that claims a factor code did not classify", () => {
    const bad = goodAssessment({ factorsTouched: ["momentum", "trend", "value"] });
    expect(validateAssessment(bad, context())).toMatchObject({ ok: false, code: "FACTOR_MISMATCH" });
  });

  it("rejects a factorsTouched set that omits a factor code did classify", () => {
    const bad = goodAssessment({ factorsTouched: ["momentum"] });
    expect(validateAssessment(bad, context())).toMatchObject({ ok: false, code: "FACTOR_MISMATCH" });
  });

  it("rejects a non-abstaining assessment with an empty thesis", () => {
    const bad = goodAssessment({ thesis: "   " });
    expect(validateAssessment(bad, context())).toMatchObject({ ok: false, code: "EMPTY_THESIS" });
  });

  it("has no order/account/size fields in its accepted shape", () => {
    const shape = Object.keys(ResearchAssessmentSchema.shape);
    for (const forbidden of ["accountId", "account", "sizeUsd", "quantity", "orderType", "side", "stopPrice", "restricted_check"]) {
      expect(shape).not.toContain(forbidden);
    }
  });

  it("produces a stable sha256-prefixed schema hash", () => {
    const h = assessmentSchemaHash();
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(assessmentSchemaHash()).toBe(h);
  });
});
