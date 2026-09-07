import { describe, expect, it } from "vitest";
import {
  applyOverlay,
  CONTAMINATION_LABEL,
  shadowSelection,
  subtractiveVetoRule,
  type OverlayAssessment,
} from "../src/model/overlay.ts";
import type { ResearchAssessment } from "../src/research/assessment.ts";

function assessment(overrides: Partial<ResearchAssessment> = {}): ResearchAssessment {
  return {
    assessmentId: "a",
    candidateId: "X",
    strategyVersion: "v1",
    evidenceFor: [{ sourceId: "obs-1", fact: "for" }],
    evidenceAgainst: [],
    missingEvidence: [],
    ontologyTags: [],
    factorsTouched: [],
    thesis: "t",
    strongestDissent: "d",
    falsifiers: [],
    expectedHorizon: "20 sessions",
    uncertainty: "medium",
    abstain: false,
    ...overrides,
  };
}

const assessed = (o: Partial<ResearchAssessment> = {}): OverlayAssessment => ({ kind: "assessed", assessment: assessment(o) });
const abstained: OverlayAssessment = { kind: "abstained" };
const netNegative = (): OverlayAssessment => assessed({ evidenceFor: [], evidenceAgainst: [{ sourceId: "obs-2", fact: "against" }] });

describe("C1 overlay (non-interaction, subtractive, contamination)", () => {
  const b1 = ["XLK", "XLV", "XLF"];

  it("C1 is always a subset of B1 and never adds a name", () => {
    const assessments = new Map<string, OverlayAssessment>([["XLK", netNegative()], ["XLV", assessed()], ["XLF", abstained]]);
    const c1 = applyOverlay({ b1Selected: b1, assessments, rule: subtractiveVetoRule, runMode: "PROSPECTIVE" });
    expect(c1.selected).toEqual(["XLV", "XLF"]); // XLK vetoed (net-negative), order preserved
    expect(c1.selected.every((s) => b1.includes(s))).toBe(true);
    expect(c1.arm).toBe("C1_LLM_OVERLAY");
  });

  it("degrades exactly to B1 when every call abstains or fails (T-07)", () => {
    const assessments = new Map<string, OverlayAssessment>(b1.map((s) => [s, abstained]));
    const c1 = applyOverlay({ b1Selected: b1, assessments, rule: subtractiveVetoRule, runMode: "PROSPECTIVE" });
    expect(c1.selected).toEqual(b1);
  });

  it("treats a candidate with no assessment as an abstention (keeps it)", () => {
    const c1 = applyOverlay({ b1Selected: b1, assessments: new Map(), rule: subtractiveVetoRule, runMode: "PROSPECTIVE" });
    expect(c1.selected).toEqual(b1);
  });

  it("does not mutate the B1 input list", () => {
    const frozen = [...b1];
    const assessments = new Map<string, OverlayAssessment>([["XLK", netNegative()]]);
    applyOverlay({ b1Selected: frozen, assessments, rule: subtractiveVetoRule, runMode: "PROSPECTIVE" });
    expect(frozen).toEqual(b1);
  });

  it("stamps the contamination label in historical replay and not in prospective mode", () => {
    const assessments = new Map<string, OverlayAssessment>();
    expect(applyOverlay({ b1Selected: b1, assessments, rule: subtractiveVetoRule, runMode: "HISTORICAL_REPLAY" }).labels).toContain(CONTAMINATION_LABEL);
    expect(applyOverlay({ b1Selected: b1, assessments, rule: subtractiveVetoRule, runMode: "PROSPECTIVE" }).labels).toEqual([]);
  });
});

describe("D1 shadow (isolated from B1/C1)", () => {
  it("selects only net-positive assessed names and ignores B1 entirely", () => {
    const assessments = new Map<string, OverlayAssessment>([
      ["AAA", assessed({ evidenceFor: [{ sourceId: "obs-1", fact: "for" }], evidenceAgainst: [] })],
      ["BBB", netNegative()],
      ["CCC", abstained],
    ]);
    const d1 = shadowSelection({ assessments, runMode: "HISTORICAL_REPLAY" });
    expect(d1.selected).toEqual(["AAA"]);
    expect(d1.arm).toBe("D1_LLM_ONLY_SHADOW");
    expect(d1.labels).toContain(CONTAMINATION_LABEL);
  });

  it("gives the same D1 result regardless of any B1 selection (no interaction)", () => {
    const assessments = new Map<string, OverlayAssessment>([["AAA", assessed()]]);
    const a = shadowSelection({ assessments, runMode: "PROSPECTIVE" });
    // shadowSelection has no parameter through which a B1 decision could enter; same input, same output.
    const b = shadowSelection({ assessments, runMode: "PROSPECTIVE" });
    expect(a).toEqual(b);
    expect(a.selected).toEqual(["AAA"]);
  });
});
