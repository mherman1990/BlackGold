import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The policy-test count never decreases (docs/THREAT_MODEL.md section 8, T-25).
 *
 * A permanent CI gate is only permanent while it exists. A refactor that deletes one `it(` from this directory
 * removes a guarantee without any other test noticing, which is exactly how a gate becomes decorative. The
 * floor is a committed number (`test/policy/POLICY_FLOOR`); it may only rise, and raising it is part of the
 * PR that adds the test. Lowering it is a decision-gated change (`scripts/check-review-state.ts`).
 *
 * This file is excluded from its own count, so its regex literals do not inflate the number.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const DIR = join(ROOT, "test/policy");
const FLOOR_FILE = join(DIR, "POLICY_FLOOR");
const SELF = basename(fileURLToPath(import.meta.url));

/** Counts `it(` and `it.each(` across every policy test file except this one. `it.skip`/`it.todo` do not count. */
export function countPolicyTests(dir: string, exclude: string): { total: number; perFile: Record<string, number> } {
  const perFile: Record<string, number> = {};
  let total = 0;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".test.ts") || f === exclude) continue;
    const text = readFileSync(join(dir, f), "utf8");
    const n = (text.match(/\bit(?:\.each)?\(/g) ?? []).length;
    perFile[f] = n;
    total += n;
  }
  return { total, perFile };
}

describe("policy test count floor", () => {
  const floor = Number(readFileSync(FLOOR_FILE, "utf8").trim());
  const counted = countPolicyTests(DIR, SELF);

  it("the floor file holds a positive integer", () => {
    expect(Number.isInteger(floor) && floor > 0).toBe(true);
  });

  it(`the policy directory holds at least ${floor} tests (counted ${counted.total})`, () => {
    expect(counted.total, JSON.stringify(counted.perFile, null, 1)).toBeGreaterThanOrEqual(floor);
  });

  it("the floor never drops below the one on origin/main", () => {
    const r = spawnSync("git", ["show", "origin/main:test/policy/POLICY_FLOOR"], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) return; // no origin/main in this checkout, or the file is new there
    const base = Number(r.stdout.trim());
    if (Number.isInteger(base)) expect(floor).toBeGreaterThanOrEqual(base);
  });

  it("the counter sees a deleted test: one fewer `it(` in a file lowers its count by exactly one", () => {
    const [victim, n] = Object.entries(counted.perFile).find(([, c]) => c > 0) ?? [];
    expect(victim).toBeDefined();
    const text = readFileSync(join(DIR, victim ?? ""), "utf8");
    const mutated = text.replace(/\bit\(/, "it.skip(");
    expect((mutated.match(/\bit(?:\.each)?\(/g) ?? []).length).toBe((n ?? 0) - 1);
  });
});
