import { describe, expect, it } from "vitest";
import { Dec, isoDate, utc, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { TR_ADJUSTMENT_VERSION } from "../src/market/series.ts";
import { candidateParamsFromCharter, selectCandidates, STRATEGY_RULES_VERSION, type CandidateParams } from "../src/strategy/candidates.ts";
import { FEATURES_VERSION, type EntityFeatures, type FeatureSet } from "../src/strategy/features.ts";

const N = (s: string): Dec => new Dec(s);
const ANCHOR: IsoDate = isoDate("2026-05-15");
const AT: UtcInstant = utc("2026-05-15T21:00:00Z");
const BIG_ADV = N("500000000");

const PARAMS: CandidateParams = {
  entryRank: 5,
  holdRank: 7,
  maxPositions: 5,
  maxNewPositionsPerDecision: 5,
  minAdvUsd: N("50000000"),
  clusters: [{ id: "A", members: ["VTI", "QQQ", "VUG", "XLK", "XLY"], maxMembers: 3 }],
};

type Spec = { mom?: string; trend?: boolean; vol?: string; adv?: string; px?: string; missing?: boolean };

/** Build a FeatureSet directly: the candidate engine is a pure function of features, held set, and params. */
function featureSet(specs: Record<string, Spec>, cashMom = "0.01"): FeatureSet {
  const features = new Map<string, EntityFeatures>();
  for (const [entityId, s] of Object.entries(specs)) {
    const f: EntityFeatures = {
      entityId,
      session: ANCHOR,
      mom: s.missing === true ? undefined : N(s.mom ?? "0.10"),
      trend: s.missing === true ? undefined : (s.trend ?? true),
      vol: s.missing === true ? undefined : N(s.vol ?? "0.15"),
      adv: s.missing === true ? undefined : N(s.adv ?? BIG_ADV.toFixed()),
      px: s.missing === true ? undefined : N(s.px ?? "100"),
      reasons: s.missing === true ? ["NO_BAR_AT_DECISION"] : [],
      labels: [],
      observationIds: [],
    };
    features.set(entityId, f);
  }
  return {
    decisionAt: AT,
    decisionSession: ANCHOR,
    anchorSession: ANCHOR,
    features,
    cashMom: cashMom === "" ? undefined : N(cashMom),
    cashEntityId: "BIL",
    covariance: undefined,
    labels: [],
    featuresVersion: FEATURES_VERSION,
    adjustmentVersion: TR_ADJUSTMENT_VERSION,
  };
}

function reasonOf(set: ReturnType<typeof selectCandidates>, entityId: string): string {
  const c = set.candidates.find((x) => x.entityId === entityId);
  if (!c) throw new Error(`no candidate row for ${entityId}`);
  return c.reason;
}

describe("eligibility", () => {
  it("takes the top five by momentum when everything is eligible", () => {
    const set = selectCandidates({
      features: featureSet({
        IWM: { mom: "0.50" },
        XLV: { mom: "0.40" },
        XLU: { mom: "0.30" },
        XLF: { mom: "0.20" },
        XLP: { mom: "0.15" },
        XLI: { mom: "0.12" },
        VTV: { mom: "0.11" },
      }),
      held: new Set(),
      params: PARAMS,
    });
    expect(set.selected).toEqual(["IWM", "XLV", "XLU", "XLF", "XLP"]);
    expect(set.entries).toEqual(set.selected);
    expect(set.exits).toEqual([]);
    expect(set.strategyRulesVersion).toBe(STRATEGY_RULES_VERSION);
    expect(reasonOf(set, "XLI")).toBe("RANK_BELOW_ENTRY");
  });

  it("rejects a name below its own moving average", () => {
    const set = selectCandidates({ features: featureSet({ XLE: { mom: "0.90", trend: false }, XLV: { mom: "0.10" } }), held: new Set(), params: PARAMS });
    expect(set.selected).toEqual(["XLV"]);
    expect(reasonOf(set, "XLE")).toBe("TREND_DOWN");
  });

  it("rejects a name whose momentum does not beat the cash leg, including an exact tie", () => {
    const set = selectCandidates({ features: featureSet({ XLU: { mom: "0.01" }, XLP: { mom: "0.009" }, XLV: { mom: "0.011" } }, "0.01"), held: new Set(), params: PARAMS });
    expect(set.selected).toEqual(["XLV"]);
    expect(reasonOf(set, "XLU")).toBe("MOMENTUM_BELOW_CASH");
    expect(reasonOf(set, "XLP")).toBe("MOMENTUM_BELOW_CASH");
  });

  it("rejects a name below the average-dollar-volume floor", () => {
    const set = selectCandidates({ features: featureSet({ XLU: { mom: "0.50", adv: "49999999" }, XLV: { mom: "0.10", adv: "50000000" } }), held: new Set(), params: PARAMS });
    expect(set.selected).toEqual(["XLV"]);
    expect(reasonOf(set, "XLU")).toBe("BELOW_ADV_FLOOR");
  });

  it("rejects a name with no usable features rather than guessing one", () => {
    const set = selectCandidates({ features: featureSet({ XLU: { missing: true }, XLV: { mom: "0.10" } }), held: new Set(), params: PARAMS });
    expect(set.selected).toEqual(["XLV"]);
    expect(reasonOf(set, "XLU")).toBe("NO_FEATURES");
  });

  it("holds nothing when the cash hurdle itself is unavailable", () => {
    const set = selectCandidates({ features: featureSet({ XLU: { mom: "0.50" }, XLV: { mom: "0.40" } }, ""), held: new Set(), params: PARAMS });
    expect(set.selected).toEqual([]);
    expect(reasonOf(set, "XLU")).toBe("CASH_HURDLE_UNAVAILABLE");
  });

  it("lets compliance remove a name and never add one", () => {
    const features = featureSet({ XLE: { mom: "0.90" }, XLV: { mom: "0.10" } });
    const open = selectCandidates({ features, held: new Set(), params: PARAMS });
    expect(open.selected).toEqual(["XLE", "XLV"]);
    const restricted = selectCandidates({ features, held: new Set(["XLE"]), params: PARAMS, restricted: new Set(["XLE"]) });
    expect(restricted.selected).toEqual(["XLV"]);
    expect(restricted.exits).toEqual(["XLE"]);
    expect(reasonOf(restricted, "XLE")).toBe("COMPLIANCE_RESTRICTED");
  });
});

describe("hysteresis", () => {
  it("keeps a held name ranked between the entry and hold ranks", () => {
    const specs: Record<string, Spec> = {
      IWM: { mom: "0.50" },
      XLV: { mom: "0.40" },
      XLU: { mom: "0.30" },
      XLF: { mom: "0.20" },
      XLP: { mom: "0.15" },
      XLI: { mom: "0.12" },
    };
    // XLI is rank 6: a new name would stay out, a held name is kept.
    const fresh = selectCandidates({ features: featureSet(specs), held: new Set(), params: PARAMS });
    expect(fresh.selected).not.toContain("XLI");
    const holding = selectCandidates({ features: featureSet(specs), held: new Set(["XLI"]), params: PARAMS });
    expect(holding.selected).toContain("XLI");
    expect(reasonOf(holding, "XLI")).toBe("ELIGIBLE_WITHIN_HOLD_RANK");
    // The book stays at five: XLI takes the slot and the lowest-ranked newcomer does not enter.
    expect(holding.selected).toHaveLength(5);
    expect(holding.selected).not.toContain("XLP");
  });

  it("exits a held name that falls past the hold rank", () => {
    const set = selectCandidates({
      features: featureSet({
        IWM: { mom: "0.50" },
        XLV: { mom: "0.40" },
        XLU: { mom: "0.30" },
        XLF: { mom: "0.20" },
        XLP: { mom: "0.15" },
        XLI: { mom: "0.14" },
        VTV: { mom: "0.13" },
        XLE: { mom: "0.01999" },
      }, "0.01"),
      held: new Set(["XLE"]),
      params: PARAMS,
    });
    expect(set.selected).not.toContain("XLE");
    expect(set.exits).toEqual(["XLE"]);
    expect(reasonOf(set, "XLE")).toBe("RANK_BELOW_HOLD");
  });

  it("exits a held name that loses eligibility whatever its rank", () => {
    for (const [spec, reason] of [
      [{ mom: "0.90", trend: false }, "TREND_DOWN"],
      [{ mom: "0.001" }, "MOMENTUM_BELOW_CASH"],
      [{ mom: "0.90", adv: "1000" }, "BELOW_ADV_FLOOR"],
      [{ missing: true }, "NO_FEATURES"],
    ] as [Spec, string][]) {
      const set = selectCandidates({ features: featureSet({ XLE: spec, XLV: { mom: "0.10" } }), held: new Set(["XLE"]), params: PARAMS });
      expect(set.selected).not.toContain("XLE");
      expect(set.exits).toEqual(["XLE"]);
      expect(reasonOf(set, "XLE")).toBe(reason);
    }
  });

  it("exits a held name dropped from the universe entirely", () => {
    const set = selectCandidates({ features: featureSet({ XLV: { mom: "0.10" } }), held: new Set(["GONE"]), params: PARAMS });
    expect(set.exits).toEqual(["GONE"]);
    expect(set.selected).toEqual(["XLV"]);
  });
});

describe("correlated-cluster cap", () => {
  it("admits at most three cluster members and backfills the freed slot up to the hold rank", () => {
    const set = selectCandidates({
      features: featureSet({
        VTI: { mom: "0.60" },
        QQQ: { mom: "0.55" },
        VUG: { mom: "0.50" },
        XLK: { mom: "0.45" },
        XLY: { mom: "0.40" },
        XLV: { mom: "0.35" },
        XLU: { mom: "0.30" },
      }),
      held: new Set(),
      params: PARAMS,
    });
    // Ranks 1-3 are cluster A and fill it; ranks 4-5 (XLK, XLY) are skipped; XLV (6) and XLU (7) backfill.
    expect(set.selected).toEqual(["VTI", "QQQ", "VUG", "XLV", "XLU"]);
    expect(reasonOf(set, "XLK")).toBe("CLUSTER_FULL");
    expect(reasonOf(set, "XLY")).toBe("CLUSTER_FULL");
    expect(reasonOf(set, "XLV")).toBe("ELIGIBLE_BACKFILL_AFTER_CLUSTER_SKIP");
    const xlk = set.candidates.find((c) => c.entityId === "XLK");
    expect(xlk?.clusterId).toBe("A");
  });

  it("does not backfill past the hold rank", () => {
    const set = selectCandidates({
      features: featureSet({
        VTI: { mom: "0.60" },
        QQQ: { mom: "0.55" },
        VUG: { mom: "0.50" },
        XLK: { mom: "0.45" },
        XLY: { mom: "0.40" },
        XLV: { mom: "0.35" },
        XLU: { mom: "0.30" },
        XLP: { mom: "0.25" },
        XLI: { mom: "0.20" },
      }),
      held: new Set(),
      params: PARAMS,
    });
    // Only XLV (6) and XLU (7) may backfill; XLP is rank 8 and stays out even though a slot logic exists.
    expect(set.selected).toEqual(["VTI", "QQQ", "VUG", "XLV", "XLU"]);
    expect(reasonOf(set, "XLP")).toBe("RANK_BELOW_ENTRY");
  });

  it("exits a held cluster member when higher-ranked members fill the cluster", () => {
    const set = selectCandidates({
      features: featureSet({ VTI: { mom: "0.60" }, QQQ: { mom: "0.55" }, VUG: { mom: "0.50" }, XLK: { mom: "0.45" }, XLV: { mom: "0.10" } }),
      held: new Set(["XLK"]),
      params: PARAMS,
    });
    expect(set.selected).not.toContain("XLK");
    expect(set.exits).toEqual(["XLK"]);
    expect(reasonOf(set, "XLK")).toBe("CLUSTER_FULL");
  });

  it("does not backfill when no cluster cap bound", () => {
    const set = selectCandidates({
      features: featureSet({ XLV: { mom: "0.50" }, XLU: { mom: "0.40" }, XLP: { mom: "0.30" } }),
      held: new Set(),
      params: PARAMS,
    });
    expect(set.selected).toEqual(["XLV", "XLU", "XLP"]);
    for (const c of set.candidates) expect(c.reason).not.toBe("ELIGIBLE_BACKFILL_AFTER_CLUSTER_SKIP");
  });
});

describe("caps and determinism", () => {
  it("respects the per-decision new-position cap", () => {
    const params: CandidateParams = { ...PARAMS, maxNewPositionsPerDecision: 2 };
    const set = selectCandidates({
      features: featureSet({ XLV: { mom: "0.50" }, XLU: { mom: "0.40" }, XLP: { mom: "0.30" }, XLI: { mom: "0.20" } }),
      held: new Set(),
      params,
    });
    expect(set.entries).toEqual(["XLV", "XLU"]);
    expect(set.selected).toEqual(["XLV", "XLU"]);
    expect(reasonOf(set, "XLP")).toBe("NEW_POSITION_CAP");
  });

  it("never exceeds the book size", () => {
    const specs: Record<string, Spec> = {};
    for (let i = 0; i < 13; i++) specs[`E${String(i).padStart(2, "0")}`] = { mom: `0.${String(90 - i).padStart(2, "0")}` };
    const set = selectCandidates({ features: featureSet(specs), held: new Set(), params: PARAMS });
    expect(set.selected).toHaveLength(PARAMS.maxPositions);
  });

  it("breaks a momentum tie by entity id so the ranking is total and reproducible", () => {
    const specs = { XLU: { mom: "0.20" }, XLP: { mom: "0.20" }, XLI: { mom: "0.20" } };
    const a = selectCandidates({ features: featureSet(specs), held: new Set(), params: PARAMS });
    const b = selectCandidates({ features: featureSet(specs), held: new Set(), params: PARAMS });
    expect(a.selected).toEqual(["XLI", "XLP", "XLU"]);
    expect(b.selected).toEqual(a.selected);
  });

  it("gives every considered entity exactly one deciding rule", () => {
    const set = selectCandidates({
      features: featureSet({ VTI: { mom: "0.60" }, QQQ: { mom: "0.55" }, VUG: { mom: "0.50" }, XLK: { mom: "0.45" }, XLE: { mom: "0.001" }, XLU: { missing: true } }),
      held: new Set(["XLE"]),
      params: PARAMS,
    });
    expect(set.candidates).toHaveLength(6);
    expect(new Set(set.candidates.map((c) => c.entityId)).size).toBe(6);
    for (const c of set.candidates) expect(typeof c.reason).toBe("string");
  });

  it("rejects a hysteresis band that narrows", () => {
    expect(() => selectCandidates({ features: featureSet({ XLV: {} }), held: new Set(), params: { ...PARAMS, holdRank: 3 } })).toThrow(RangeError);
  });
});

describe("candidateParamsFromCharter", () => {
  it("reads the registered rule table out of the charter", async () => {
    const { loadCharterFile } = await import("../src/strategy/charter.ts");
    const { fileURLToPath } = await import("node:url");
    const { charter } = loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url)));
    const p = candidateParamsFromCharter(charter);
    expect(p.entryRank).toBe(5);
    expect(p.holdRank).toBe(7);
    expect(p.maxPositions).toBe(5);
    expect(p.minAdvUsd.eq(N("50000000"))).toBe(true);
    expect(p.clusters).toEqual([{ id: "A", members: ["VTI", "QQQ", "VUG", "XLK", "XLY"], maxMembers: 3 }]);
  });
});
