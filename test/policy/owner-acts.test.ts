import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { SECRET_FILE_KEYS, SignerError, validateSigner } from "@blackgold/core";

/**
 * The owner's acts stay the owner's (CLAUDE.md "What standing authorization never covers"; D-60 item 4; plan B1).
 * `experiment register|mark-viewed|open-holdout` take the signer typed on the line, refuse placeholders, ship no
 * default and no environment fallback, and no tracked script or workflow invokes them. The build commit the
 * registration freezes is baked by CI, never read from the secrets file.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const read = (p: string): string => readFileSync(`${ROOT}/${p}`, "utf8");

/** Lines of tracked operator files that RUN something: comments and echo/printf strings are text, not invocations. */
function invocationLines(file: string): string[] {
  const out: string[] = [];
  for (const raw of read(file).split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (/^(echo|printf)\b/.test(line)) continue;
    out.push(line);
  }
  return out;
}

const OWNER_ACT = /\b(experiment (register|open-holdout|mark-viewed)|shadow rearm|policy sign|corporate-actions sign)\b/;

describe("owner acts", () => {
  it("every sign-type CLI refuses '', 'owner', 'TODO', 'Claude', 'Claude Code' and example values as the signer", () => {
    for (const v of ["", "owner", "TODO", "Claude", "Claude Code", "example", "test", "$BLACKGOLD_SIGNER", "<your name>"]) {
      expect(() => validateSigner(v, "--registered-by"), v).toThrow(SignerError);
    }
    expect(validateSigner("Matt Herman", "--registered-by")).toBe("Matt Herman");
  });

  it("the CLI ships no default signer and reads none from the environment", () => {
    const main = read("packages/core/src/main.ts");
    const cli = read("packages/core/src/research/experiment-cli.ts");
    const load = read("packages/core/src/config/load.ts");
    for (const text of [main, cli]) {
      expect(text).not.toContain("BLACKGOLD_SIGNER");
      expect(text).not.toContain("process.env");
    }
    expect(load).not.toMatch(/get\("SIGNER"\)/);
    // The register path takes the signer from the flag only: a missing flag is a usage error, never a default.
    expect(main).toMatch(/experiment register requires --registered-by/);
    expect(cli).toMatch(/validateSigner\(args\.registeredBy, "--registered-by"\)/);
    expect(cli).toMatch(/validateSigner\(args\.viewedBy, "--viewed-by"\)/);
    expect(cli).toMatch(/validateSigner\(args\.requestedBy, "--requested-by"\)/);
  });

  it("no tracked script or workflow invokes an owner act (printing the line is allowed; running it is not)", () => {
    const files = execFileSync("git", ["ls-files", "scripts", ".github", "blackgold-trading"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.length > 0 && !f.endsWith(".md") && !f.endsWith(".json"));
    const hits: string[] = [];
    for (const f of files) for (const line of invocationLines(f)) if (OWNER_ACT.test(line)) hits.push(`${f}: ${line}`);
    expect(hits).toEqual([]);
  });

  it("the scan itself sees an invocation and ignores an echo of one", () => {
    expect(OWNER_ACT.test('bg experiment register --charter x --registered-by "$BLACKGOLD_SIGNER"')).toBe(true);
    expect(invocationLines("scripts/pi/eval-store.sh").some((l) => OWNER_ACT.test(l))).toBe(false);
    expect(read("scripts/pi/eval-store.sh")).toMatch(/experiment register/);
  });

  describe("the build commit the registration freezes", () => {
    it("is baked by the Dockerfile from a build-arg and never admitted to the secrets file", () => {
      const dockerfile = read("Dockerfile");
      expect(dockerfile).toMatch(/^ARG BLACKGOLD_BUILD_COMMIT=$/m);
      expect(dockerfile).toMatch(/^ENV BLACKGOLD_BUILD_COMMIT=\$\{BLACKGOLD_BUILD_COMMIT\}$/m);
      expect(SECRET_FILE_KEYS.has("BLACKGOLD_BUILD_COMMIT")).toBe(false);
      expect(SECRET_FILE_KEYS.has("BLACKGOLD_TIINGO_API_KEY")).toBe(true);
    });

    it("ci passes github.sha to BOTH image builds and asserts the baked value in the smoke test", () => {
      const ci = parse(read(".github/workflows/ci.yml")) as { jobs: Record<string, { steps?: { uses?: string; with?: Record<string, string>; run?: string }[] }> };
      const builds = Object.values(ci.jobs)
        .flatMap((j) => j.steps ?? [])
        .filter((s) => s.uses?.startsWith("docker/build-push-action") === true);
      expect(builds.length).toBe(2);
      for (const b of builds) expect(b.with?.["build-args"]).toContain("BLACKGOLD_BUILD_COMMIT=${{ github.sha }}");
      const smoke = Object.values(ci.jobs)
        .flatMap((j) => j.steps ?? [])
        .map((s) => s.run ?? "")
        .join("\n");
      expect(smoke).toMatch(/c\.buildCommit!==process\.env\.GITHUB_SHA/);
    });

    it("release passes the guard's resolved sha, never the dispatch ref", () => {
      const raw = read(".github/workflows/release.yml");
      expect(raw).toMatch(/BLACKGOLD_BUILD_COMMIT=\$\{\{ needs\.guard\.outputs\.sha \}\}/);
      expect(raw).not.toMatch(/BLACKGOLD_BUILD_COMMIT=\$\{\{ github\.sha \}\}/);
    });
  });
});
