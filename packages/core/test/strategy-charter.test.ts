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
    expect(c.pass_fail).toMatchObject({ primary_threshold: "0.10", bootstrap_block_sessions: 21, max_drawdown_ratio: "0.75", minimum_independent_decisions: 150 });
  });

  it("declares a 72-member sensitivity grid containing the registered point", () => {
    const g = loaded().sensitivity_grid;
    const members =
      g.momentum.length * g.trend_sma_sessions.length * g.volatility_sessions.length * g.ranks.length * g.annual_volatility_target.length * g.rebalance_band_pct_points.length;
    expect(members).toBe(72);
  });
});

describe("registrability gate", () => {
  it("refuses the tracked draft charter", () => {
    const c = loaded();
    expect(isRegistrable(c)).toBe(false);
    const reasons = registrabilityReasons(c);
    expect(reasons).toContain("approval.state is DRAFT; only APPROVED may be registered");
    expect(reasons.some((r) => r.includes("OD-1"))).toBe(true);
    expect(reasons.some((r) => r.includes("XLE"))).toBe(true);
    expect(() => {
      assertRegistrable(c);
    }).toThrow(CharterNotRegistrableError);
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
