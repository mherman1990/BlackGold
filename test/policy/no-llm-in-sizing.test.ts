import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Permanent CI gate for the Phase 3 runtime-LLM boundary (threat model T-05; docs/PRODUCT_SPEC.md section 6).
 *
 * The whole point of the architecture is that no model output can set a position size, choose an account, or
 * form an order. That is guaranteed structurally - the sizing and candidate engines read only deterministic
 * inputs and the ResearchAssessment type has no field they consume - but a future refactor could quietly
 * import an assessment into the sizing path. These greps make that a red build.
 *
 * They also fence the new model/ layer the same way the research layer is fenced: no broker gateway, no order
 * type, and no environment reads (a decision path must not pick up a secret or a mode from the environment).
 */

const REPO = new URL("../..", import.meta.url).pathname;

function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function imports(text: string): string[] {
  return [...text.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1] ?? "");
}

describe("no LLM output can reach sizing or order formation (T-05)", () => {
  it("the sizing and candidate engines import no assessment, packet, or model module", () => {
    for (const file of [join(REPO, "packages/core/src/strategy/construct.ts"), join(REPO, "packages/core/src/strategy/candidates.ts")]) {
      const text = readFileSync(file, "utf8");
      for (const specifier of imports(text)) {
        expect(specifier).not.toContain("research/assessment");
        expect(specifier).not.toContain("research/packet");
        expect(specifier).not.toMatch(/(^|\/)model\//);
      }
    }
  });

  it("no strategy-layer module imports the model layer or the assessment/packet types", () => {
    for (const file of sources(join(REPO, "packages/core/src/strategy"))) {
      for (const specifier of imports(readFileSync(file, "utf8"))) {
        expect(specifier).not.toMatch(/(^|\/)model\//);
        expect(specifier).not.toContain("research/assessment");
        expect(specifier).not.toContain("research/packet");
      }
    }
  });

  it("the model layer never imports the broker gateway or forms an order", () => {
    for (const file of sources(join(REPO, "packages/core/src/model"))) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("broker-gateway");
      expect(text).not.toContain("OrderIntent");
    }
  });

  it("the model layer reads no environment and reaches no raw write path", () => {
    for (const file of sources(join(REPO, "packages/core/src/model"))) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("process.env");
      for (const forbidden of [".append(", ".createSnapshot(", "INSERT INTO", "UPDATE "]) {
        expect(text).not.toContain(forbidden);
      }
    }
  });
});
