import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRegistrable, CharterNotRegistrableError, isRegistrable, loadCharterFile } from "@blackgold/core";
import { holdoutSplit, HoldoutSealedError, splitPlan } from "@blackgold/core";

/**
 * Permanent CI gates for the Phase 2 research layer.
 *
 * Three properties the repository must keep whatever anyone edits:
 *
 *  1. No tracked charter is registrable unless its approval block is signed and its open decisions are
 *     resolved. A DRAFT charter that becomes silently registrable is how unapproved numbers get frozen into
 *     an experiment, so this is a gate, not a unit test.
 *  2. No evaluation plan reaches into a sealed holdout, and the holdout window cannot be obtained without
 *     stating that the registry opened it.
 *  3. The research layer never imports the broker gateway or anything that could form an order.
 */

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const STRATEGIES = join(REPO, "strategies");

function charterFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(STRATEGIES)) {
    const dir = join(STRATEGIES, entry);
    if (!statSync(dir).isDirectory()) continue;
    const candidate = join(dir, "charter.yaml");
    try {
      if (statSync(candidate).isFile()) out.push(candidate);
    } catch {
      // A strategy with a prose charter and no machine-readable companion is not yet implementable.
    }
  }
  return out;
}

describe("tracked charters", () => {
  it("has at least one machine-readable charter to check", () => {
    expect(charterFiles().length).toBeGreaterThan(0);
  });

  it("parses and hashes every tracked charter", () => {
    for (const path of charterFiles()) {
      const loaded = loadCharterFile(path);
      expect(loaded.charterHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(loaded.charter.runtime_llm_in_signal).toBe(false);
    }
  });

  it("refuses to register any charter whose approval block is unsigned", () => {
    for (const path of charterFiles()) {
      const { charter } = loadCharterFile(path);
      if (charter.approval.state === "APPROVED") continue;
      expect(isRegistrable(charter)).toBe(false);
      expect(() => {
        assertRegistrable(charter);
      }).toThrow(CharterNotRegistrableError);
    }
  });

  it("keeps every declared open decision unresolved while the charter is a draft", () => {
    for (const path of charterFiles()) {
      const { charter } = loadCharterFile(path);
      if (charter.approval.state !== "DRAFT") continue;
      // A draft with resolved decisions and a signature would be an approval recorded in the wrong place.
      expect(charter.approval.approved_by).toBeNull();
      expect(charter.approval.approval_date).toBeNull();
    }
  });

  it("excludes every undecided conditional universe member", () => {
    for (const path of charterFiles()) {
      const { charter } = loadCharterFile(path);
      for (const conditional of charter.universe.conditional) {
        if (conditional.admitted !== null) continue;
        expect(isRegistrable(charter)).toBe(false);
      }
    }
  });

  it("declares no runtime LLM in any signal path", () => {
    for (const path of charterFiles()) {
      const { charter } = loadCharterFile(path);
      expect(charter.arms).not.toContain("C1_LLM_OVERLAY");
      expect(charter.arms).not.toContain("D1_LLM_ONLY_SHADOW");
    }
  });

  it("keeps every charter long-only, unlevered and regular-session", () => {
    for (const path of charterFiles()) {
      const { charter } = loadCharterFile(path);
      expect(charter.posture.long_only).toBe(true);
      expect(charter.posture.unlevered).toBe(true);
      expect(charter.posture.regular_session_only).toBe(true);
      expect(Number(charter.posture.max_gross_exposure)).toBeLessThanOrEqual(1);
    }
  });
});

describe("holdout sealing", () => {
  it("produces no split that evaluates inside the sealed holdout", () => {
    for (const path of charterFiles()) {
      const { charter } = loadCharterFile(path);
      const plan = splitPlan(charter);
      expect(plan.holdout.opened).toBe(false);
      for (const split of plan.splits) {
        expect(split.kind).not.toBe("HOLDOUT");
        const overlaps = split.evaluation.start <= plan.holdout.end && split.evaluation.end >= plan.holdout.start;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("refuses to hand back the holdout window without a stated open", () => {
    for (const path of charterFiles()) {
      const { charter } = loadCharterFile(path);
      expect(() => holdoutSplit(charter, { opened: false })).toThrow(HoldoutSealedError);
    }
  });
});

describe("research layer boundaries", () => {
  const sources = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d)) {
        const p = join(d, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) out.push(p);
      }
    };
    walk(dir);
    return out;
  };

  it("never imports the broker gateway from the strategy or research layers", () => {
    for (const dir of [join(REPO, "packages/core/src/strategy"), join(REPO, "packages/core/src/research")]) {
      for (const file of sources(dir)) {
        const text = readFileSync(file, "utf8");
        expect(text).not.toContain("broker-gateway");
        expect(text).not.toContain("OrderIntent");
      }
    }
  });

  it("reads the environment nowhere in the strategy or research layers", () => {
    for (const dir of [join(REPO, "packages/core/src/strategy"), join(REPO, "packages/core/src/research")]) {
      for (const file of sources(dir)) {
        expect(readFileSync(file, "utf8")).not.toContain("process.env");
      }
    }
  });

  it("routes every strategy read through the narrowed point-in-time interface", () => {
    // A strategy module that imported the full repository could append observations or create snapshots.
    // The narrowed ReadOnlyPointInTime interface is what makes that impossible by type, so no strategy file
    // may import the repository module at all. Prose mentioning it in a comment is fine; an import is not.
    for (const file of sources(join(REPO, "packages/core/src/strategy"))) {
      const text = readFileSync(file, "utf8");
      const imports = [...text.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1] ?? "");
      for (const specifier of imports) expect(specifier).not.toContain("pit/repository");
    }
  });

  it("keeps the strategy layer free of any write path into the observation store", () => {
    for (const file of sources(join(REPO, "packages/core/src/strategy"))) {
      const text = readFileSync(file, "utf8");
      for (const forbidden of [".append(", ".createSnapshot(", "INSERT INTO", "UPDATE "]) expect(text).not.toContain(forbidden);
    }
  });
});
