import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  admittedRiskEtfs,
  assertRegistrable,
  charterHash,
  CharterNotRegistrableError,
  charterUniverseMembers,
  InvalidCharterError,
  isRegistrable,
  loadCharterFile,
  loadCharterFromYaml,
  parseCharter,
  registrabilityReasons,
  type Charter,
} from "../src/strategy/charter.ts";

const CHARTER_PATH = fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url));

function loaded(): Charter {
  return loadCharterFile(CHARTER_PATH).charter;
}

/** A structurally valid charter with everything signed, for the positive registrability path. */
function approved(): Charter {
  const c = structuredClone(loaded());
  c.approval = {
    ...c.approval,
    state: "APPROVED",
    approved_by: "Matt Herman",
    approval_date: "2026-09-30",
    code_commit: "0123456789ab",
    approval_ref: "docs/DECISIONS.md#D-32",
    open_decisions: c.approval.open_decisions.map((d) => ({ ...d, resolution: "resolved in D-32" })),
  };
  c.universe.conditional = c.universe.conditional.map((cd) => ({ ...cd, admitted: false }));
  return c;
}

describe("charter.yaml", () => {
  it("loads, validates, and hashes the tracked draft charter", () => {
    const { charter, charterHash: hash } = loadCharterFile(CHARTER_PATH);
    expect(charter.strategy_id).toBe("etf-trend-vol");
    expect(charter.runtime_llm_in_signal).toBe(false);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("hashes deterministically and changes when any value changes", () => {
    const c = loaded();
    expect(charterHash(c)).toBe(charterHash(structuredClone(c)));
    const tweaked = structuredClone(c);
    tweaked.sizing.annual_volatility_target = "0.12";
    expect(charterHash(tweaked)).not.toBe(charterHash(c));
  });

  it("signing the approval block changes the hash", () => {
    expect(charterHash(approved())).not.toBe(charterHash(loaded()));
  });

  it("transcribes the prose charter's registered parameters", () => {
    const c = loaded();
    expect(c.features).toMatchObject({ momentum_lookback_sessions: 252, momentum_skip_sessions: 21, trend_sma_sessions: 200, volatility_sessions: 63, adv_sessions: 20 });
    expect(c.rules).toMatchObject({ entry_rank: 5, hold_rank: 7, max_positions: 5, execution_delay_bars: 1, decision_offset_minutes: 60 });
    expect(c.sizing).toMatchObject({ max_weight_per_etf: "0.20", min_cash_weight: "0.02", annual_volatility_target: "0.10" });
    expect(c.pass_fail).toMatchObject({ primary_threshold: "0.10", bootstrap_block_sessions: 21, max_drawdown_ratio: "0.75", minimum_independent_decisions: 100 });
  });

  it("carries the owner's 0.3.0 answers (D-56) into the fields the code executes", () => {
    // The OD resolutions are prose a person reads; these fields are what the aggregate actually acts on. A
    // resolution with no executable counterpart would be a decision the code silently ignores.
    const c = loaded();
    expect(c.charter_version).toBe("0.3.0");
    expect(c.approval.open_decisions.map((d) => d.id)).toEqual(["OD-1", "OD-2", "OD-3", "OD-4", "OD-5", "OD-6", "OD-7", "OD-8", "OD-9", "OD-10", "OD-11", "OD-12", "OD-13"]);
    expect(c.approval.open_decisions.every((d) => d.resolution !== null)).toBe(true);
    expect(c.pass_fail.primary_metric).toBe("net_sharpe_difference_vs_primary_benchmark"); // OD-5: kept
    expect(c.pass_fail.promotion_co_gates).toEqual(["F2"]); // OD-5, OD-6
    expect(c.pass_fail.mixed_verdict).toBe("OWNER_REVIEW_NEVER_ACTIVE"); // OD-7
    expect(c.pass_fail.minimum_independent_decisions).toBe(100); // OD-8
    expect(c.benchmarks.secondary_2_readings).toEqual({ rescale: "WEEKLY_AT_DECISION_INSTANTS", ex_date_rebalance_income: "CASH_REALLOCATED_AT_OPEN" }); // OD-9
    expect(c.component_versions.features).toBe(2);
    expect(c.component_versions.risk_policy).toBe(1); // OD-11, OD-12: the operative risk.yaml is 0.2.0
    expect(c.costs.max_participation_of_adv).toBe("0.005"); // OD-12: unchanged; risk.yaml moved to it
    expect(c.approval.approval_ref).toBe("docs/DECISIONS.md#D-56");
  });

  it("declares a 72-member sensitivity grid containing the registered point", () => {
    const g = loaded().sensitivity_grid;
    const members =
      g.momentum.length * g.trend_sma_sessions.length * g.volatility_sessions.length * g.ranks.length * g.annual_volatility_target.length * g.rebalance_band_pct_points.length;
    expect(members).toBe(72);
  });
});

/**
 * The owner signed 0.2.0 on 2026-09-12 against this exact file; its hash is what any 0.2.0 registration or
 * sealed shadow record binds. A schema change that injects a key into every parsed charter - a `.default()` on
 * a new field, say - would move that hash without anyone touching the file, which is a signed artifact
 * changing identity behind the owner's back. The fixture is a frozen copy so the tracked charter can move on.
 */
const SIGNED_0_2_0_PATH = fileURLToPath(new URL("./fixtures/etf-trend-vol-charter-0.2.0-signed.yaml", import.meta.url));
const SIGNED_0_2_0_HASH = "sha256:5c7f94da552b8bc668af25df482410a510cafdb21475bf1fcf3741c8d1e00d25";

describe("schema additions never move a signed charter's hash", () => {
  it("the owner-signed 0.2.0 charter still hashes to what was signed", () => {
    const { charter, charterHash: hash } = loadCharterFile(SIGNED_0_2_0_PATH);
    expect(charter.charter_version).toBe("0.2.0");
    expect(charter.approval.state).toBe("APPROVED");
    expect(hash).toBe(SIGNED_0_2_0_HASH);
  });

  it("adds no key for a 0.3.0 field the charter does not declare", () => {
    const c = loadCharterFile(SIGNED_0_2_0_PATH).charter;
    expect(Object.keys(c.pass_fail)).not.toContain("promotion_co_gates");
    expect(Object.keys(c.pass_fail)).not.toContain("mixed_verdict");
    expect(Object.keys(c.benchmarks)).not.toContain("secondary_2_readings");
  });
});

describe("0.3.0 charter fields admit only what the code implements", () => {
  const base = (): Charter => structuredClone(loadCharterFile(SIGNED_0_2_0_PATH).charter);
  const issuesOf = (value: unknown): string[] => {
    try {
      parseCharter(value);
      return [];
    } catch (e) {
      if (e instanceof InvalidCharterError) return e.issues;
      throw e;
    }
  };

  it("accepts the readings, routing and co-gate the code implements", () => {
    const c = base();
    c.pass_fail.promotion_co_gates = ["F2"];
    c.pass_fail.mixed_verdict = "OWNER_REVIEW_NEVER_ACTIVE";
    c.benchmarks.secondary_2_readings = { rescale: "WEEKLY_AT_DECISION_INSTANTS", ex_date_rebalance_income: "CASH_REALLOCATED_AT_OPEN" };
    expect(issuesOf(c)).toEqual([]);
  });

  it("refuses a co-gate the aggregate does not evaluate", () => {
    const c = base() as unknown as { pass_fail: Record<string, unknown> };
    c.pass_fail["promotion_co_gates"] = ["F3"];
    expect(issuesOf(c).join("; ")).toMatch(/promotion_co_gates/);
  });

  it("refuses a co-gate the charter does not declare as a falsifier, and a duplicate", () => {
    const undeclared = base();
    undeclared.pass_fail.promotion_co_gates = ["F2"];
    undeclared.pass_fail.falsifiers = undeclared.pass_fail.falsifiers.filter((f) => f.id !== "F2");
    expect(issuesOf(undeclared)).toContain("pass_fail.promotion_co_gates F2 is not a declared falsifier");

    const twice = base();
    twice.pass_fail.promotion_co_gates = ["F2", "F2"];
    expect(issuesOf(twice)).toContain("pass_fail.promotion_co_gates lists a falsifier twice");
  });

  it("refuses a Secondary 2 reading or a routing the code does not implement", () => {
    const daily = base() as unknown as { benchmarks: Record<string, unknown> };
    daily.benchmarks["secondary_2_readings"] = { rescale: "EVERY_SESSION", ex_date_rebalance_income: "CASH_REALLOCATED_AT_OPEN" };
    expect(issuesOf(daily).join("; ")).toMatch(/secondary_2_readings/);

    const closeReinvest = base() as unknown as { benchmarks: Record<string, unknown> };
    closeReinvest.benchmarks["secondary_2_readings"] = { rescale: "WEEKLY_AT_DECISION_INSTANTS", ex_date_rebalance_income: "REINVESTED_AT_CLOSE" };
    expect(issuesOf(closeReinvest).join("; ")).toMatch(/secondary_2_readings/);

    const toActive = base() as unknown as { pass_fail: Record<string, unknown> };
    toActive.pass_fail["mixed_verdict"] = "OWNER_REVIEW_MAY_ACTIVATE";
    expect(issuesOf(toActive).join("; ")).toMatch(/mixed_verdict/);
  });
});

describe("registrability gate", () => {
  it("now accepts the tracked charter: the owner signed the approval block", () => {
    // The owner resolved all four open decisions and settled the XLE condition on 2026-09-07 (D-39), then signed
    // the approval block on 2026-09-08 (charter_version 0.1.0, code_commit 474d0dc, ref docs/DECISIONS.md#D-39).
    // The tracked charter has since been re-cut to 0.2.0 to adopt Tiingo bars, and the owner signed that version
    // too on 2026-09-12 (code_commit 115dae4, ref docs/DECISIONS.md#D-50). The assertions below are deliberately
    // version-agnostic: they pin the signed, registrable *state*, not one version's signature, so a future
    // charter version starting at DRAFT fails this test until the owner signs it. This was the tripwire that
    // forced signing to be a visible, reviewed change; now
    // that the signature exists it asserts the signed, registrable state, and it still guards the other
    // direction - unsigning the charter must fail closed again. Signing is the owner's act, beyond any grant of
    // autonomy in CLAUDE.md; reconciling this test to a signature the owner already made is not.
    const c = loaded();
    expect(c.approval.state).toBe("APPROVED");
    expect(c.approval.approved_by).not.toBeNull();
    expect(c.approval.approval_date).not.toBeNull();
    expect(c.approval.code_commit).not.toBeNull();
    expect(c.approval.approval_ref).not.toBeNull();
    expect(registrabilityReasons(c)).toEqual([]);
    expect(isRegistrable(c)).toBe(true);
    expect(() => {
      assertRegistrable(c);
    }).not.toThrow();

    // The gate must still bite the other way: reverting the signature makes the tracked charter unregistrable.
    const unsigned = structuredClone(c);
    unsigned.approval.state = "DRAFT";
    unsigned.approval.approved_by = null;
    expect(isRegistrable(unsigned)).toBe(false);
    expect(() => {
      assertRegistrable(unsigned);
    }).toThrow(CharterNotRegistrableError);
  });

  it("admits 12 risk ETFs with XLE excluded, per OD-1", () => {
    // The universe the charter actually executes on, asserted against the resolved condition rather than
    // trusted. XLE holding refiners with RFS/45Z exposure is why it is out; a silent re-admission would be a
    // compliance problem, not a config change.
    const c = loaded();
    expect(admittedRiskEtfs(c)).toEqual(["VTI", "QQQ", "IWM", "VTV", "VUG", "XLK", "XLF", "XLV", "XLI", "XLP", "XLU", "XLY"]);
    expect(admittedRiskEtfs(c)).not.toContain("XLE");
  });

  it("accepts a fully signed charter with every open decision resolved", () => {
    const c = approved();
    expect(registrabilityReasons(c)).toEqual([]);
    expect(() => {
      assertRegistrable(c);
    }).not.toThrow();
  });

  it("still refuses when the state is APPROVED but a signature or reference is missing", () => {
    for (const field of ["approved_by", "approval_date", "code_commit", "approval_ref"] as const) {
      const c = approved();
      c.approval[field] = null;
      expect(isRegistrable(c)).toBe(false);
      expect(registrabilityReasons(c).join(" ")).toContain(field);
    }
  });

  it("refuses while any open decision or conditional member is undecided", () => {
    const withOpen = approved();
    const first = withOpen.approval.open_decisions[0];
    if (first) first.resolution = null;
    expect(isRegistrable(withOpen)).toBe(false);

    const undecided = approved();
    undecided.universe.conditional = undecided.universe.conditional.map((cd) => ({ ...cd, admitted: null }));
    expect(isRegistrable(undecided)).toBe(false);
  });
});

describe("admitted universe", () => {
  it("excludes an undecided conditional member: unknown state fails closed", () => {
    const c = loaded();
    expect(c.universe.risk_etfs).toContain("XLE");
    expect(admittedRiskEtfs(c)).not.toContain("XLE");
    expect(admittedRiskEtfs(c)).toHaveLength(12);
    expect(charterUniverseMembers(c)).toEqual([...admittedRiskEtfs(c), "BIL"].sort());
  });

  it("admits a conditional member only on a positive decision", () => {
    const c = approved();
    expect(admittedRiskEtfs(c)).not.toContain("XLE");
    c.universe.conditional = c.universe.conditional.map((cd) => ({ ...cd, admitted: true }));
    expect(admittedRiskEtfs(c)).toContain("XLE");
    expect(admittedRiskEtfs(c)).toHaveLength(13);
  });
});

describe("structural validation", () => {
  const base = (): Record<string, unknown> => structuredClone(loaded());

  function expectIssue(mutate: (c: Charter) => void, fragment: string): void {
    const c = base() as unknown as Charter;
    mutate(c);
    try {
      parseCharter(c, "test");
      throw new Error(`expected an issue containing ${fragment}`);
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidCharterError);
      expect((e as InvalidCharterError).issues.join(" | ")).toContain(fragment);
    }
  }

  it("rejects hysteresis that narrows instead of widening", () => {
    expectIssue((c) => {
      c.rules.hold_rank = 4;
    }, "hold_rank must be at or above");
  });

  it("rejects a book bound that disagrees with the entry rank", () => {
    expectIssue((c) => {
      c.rules.max_positions = 6;
    }, "max_positions must equal");
  });

  it("rejects a momentum skip that swallows the lookback", () => {
    expectIssue((c) => {
      c.features.momentum_skip_sessions = 252;
    }, "momentum_skip_sessions must be shorter");
  });

  it("rejects a per-ETF cap that could never fund the book", () => {
    expectIssue((c) => {
      c.sizing.max_weight_per_etf = "0.10";
    }, "could never be fully invested");
  });

  it("rejects a cluster cap that does not constrain its cluster", () => {
    expectIssue((c) => {
      const cluster = c.sizing.clusters[0];
      if (cluster) cluster.max_members = 5;
    }, "does not constrain");
  });

  it("rejects overlapping or out-of-order evaluation segments", () => {
    expectIssue((c) => {
      c.boundaries.holdout.start = "2018-06-01";
    }, "holdout must start after the design period ends");
    expectIssue((c) => {
      c.boundaries.recent.start = "2024-06-01";
    }, "recent must start after the holdout ends");
  });

  it("rejects a registered point that is not a grid member", () => {
    expectIssue((c) => {
      c.sizing.annual_volatility_target = "0.11";
    }, "registered point must itself be a member");
  });

  it("rejects the cash ETF also appearing as a risk ETF", () => {
    expectIssue((c) => {
      c.universe.risk_etfs = [...c.universe.risk_etfs, "BIL"];
    }, "must not also be a risk ETF");
  });

  it("rejects a charter that admits a runtime LLM into the signal", () => {
    const c = base();
    (c as { runtime_llm_in_signal: boolean }).runtime_llm_in_signal = true;
    expect(() => parseCharter(c, "test")).toThrow(InvalidCharterError);
  });

  it("rejects unknown keys and malformed YAML", () => {
    const c = base();
    c["extra_knob"] = 1;
    expect(() => parseCharter(c, "test")).toThrow(InvalidCharterError);
    expect(() => loadCharterFromYaml("strategy_id: [", "test")).toThrow(InvalidCharterError);
  });
});
