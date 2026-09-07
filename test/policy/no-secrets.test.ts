import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("../..", import.meta.url).pathname;

describe("no secrets or sensitive data in the repository", () => {
  it("check-secrets script passes over tracked files", () => {
    const out = execFileSync("node", ["scripts/check-secrets.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/secret scan ok/);
  });

  it(".gitignore excludes runtime data, secrets, live authorization, and CLAUDE.local.md", () => {
    const gi = readFileSync(`${ROOT}/.gitignore`, "utf8");
    for (const must of ["CLAUDE.local.md", ".env", "*.sqlite", "LIVE_AUTHORIZATION.yaml", "data/", "backups/", "secrets/"]) {
      expect(gi, `missing ${must}`).toContain(must);
    }
  });

  it("every fake-value config example is tracked (an ignore rule must not swallow documentation)", () => {
    const files = execFileSync("git", ["ls-files", "config/examples"], { cwd: ROOT, encoding: "utf8" }).split("\n");
    for (const name of ["app.env.example", "risk.yaml", "financial-picture.yaml", "restricted-list.yaml", "LIVE_AUTHORIZATION.example.yaml"]) {
      expect(files, name).toContain(`config/examples/${name}`);
    }
  });

  it("no runtime database, backup, or env file is tracked", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n");
    const bad = files.filter((f) => /\.(sqlite|sqlite-wal|sqlite-shm|db)$/.test(f) || /^\.env(\..*)?$/.test(f) || /LIVE_AUTHORIZATION\.ya?ml$/.test(f));
    expect(bad).toEqual([]);
  });
});
