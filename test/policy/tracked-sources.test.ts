import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", "coverage", ".git"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full));
  }
}

describe("source files are never silently excluded by ignore rules", () => {
  it("no file under packages/, config/, blackgold-trading/, scripts/, or test/ is gitignored", () => {
    const files: string[] = [];
    for (const d of ["packages", "config", "blackgold-trading", "scripts", "test"]) walk(join(ROOT, d), files);
    expect(files.length).toBeGreaterThan(50);
    // git check-ignore exits 1 with no output when nothing is ignored; exits 0 listing ignored paths otherwise.
    let ignored = "";
    try {
      ignored = execFileSync("git", ["check-ignore", "--", ...files], { cwd: ROOT, encoding: "utf8" });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      if (e.status !== 1) throw err;
      ignored = e.stdout ?? "";
    }
    expect(ignored.trim().split("\n").filter(Boolean)).toEqual([]);
  });

  it("every source file on disk is tracked or staged (nothing forgotten)", () => {
    const tracked = new Set(execFileSync("git", ["ls-files", "packages", "config", "blackgold-trading", "scripts", "test"], { cwd: ROOT, encoding: "utf8" }).split("\n"));
    const files: string[] = [];
    for (const d of ["packages", "config", "blackgold-trading", "scripts", "test"]) walk(join(ROOT, d), files);
    const untracked = files.filter((f) => !tracked.has(f) && !/\.(sqlite|log)$/.test(f));
    // Allow work in progress in a developer checkout, but never in CI.
    if (process.env["CI"]) expect(untracked).toEqual([]);
  });
});
