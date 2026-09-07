import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const ROOT = new URL("../..", import.meta.url).pathname;

describe("identity and release policy", () => {
  it("check-identity script passes", () => {
    const out = execFileSync("node", ["scripts/check-identity.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/identity check ok/);
  });

  it("store id prefixes app id and compose pins the release version", () => {
    const store = parse(readFileSync(`${ROOT}/umbrel-app-store.yml`, "utf8")) as { id: string };
    const app = parse(readFileSync(`${ROOT}/blackgold-trading/umbrel-app.yml`, "utf8")) as { id: string; version: string };
    expect(app.id.startsWith(`${store.id}-`)).toBe(true);
    const compose = readFileSync(`${ROOT}/blackgold-trading/docker-compose.yml`, "utf8");
    expect(compose).not.toMatch(/:latest/);
    expect(compose).toMatch(new RegExp(`ghcr.io/mherman1990/blackgold:${app.version.replaceAll(".", "\\.")}`));
  });

  it("compose commands do not repeat the Dockerfile ENTRYPOINT executable", () => {
    const dockerfile = readFileSync(`${ROOT}/Dockerfile`, "utf8");
    const entry = /^ENTRYPOINT\s+\[\s*"([^"]+)"/m.exec(dockerfile)?.[1];
    expect(entry).toBe("node");
    const compose = parse(readFileSync(`${ROOT}/blackgold-trading/docker-compose.yml`, "utf8")) as {
      services: Record<string, { command?: string[]; healthcheck?: { test?: string[] } }>;
    };
    for (const [name, svc] of Object.entries(compose.services)) {
      if (svc.command) {
        expect(svc.command[0], `${name}.command`).not.toBe(entry);
        expect(svc.command[0], `${name}.command`).toMatch(/\.js$/);
      }
      // Healthchecks bypass ENTRYPOINT, so they must name the executable explicitly.
      if (svc.healthcheck?.test) expect(svc.healthcheck.test.slice(0, 2), `${name}.healthcheck`).toEqual(["CMD", "node"]);
    }
  });

  // This used to assert `workflow_dispatch` was absent, on the theory that a semver tag push was the
  // only acceptable way to publish. D-38 replaced that with a dispatch path, because GitHub refuses
  // Claude Code's credential any tag ref and the release chain was stalling on a manual command.
  //
  // The trigger shape was never the thing worth protecting - what mattered is that a release can only
  // ever publish reviewed code at the declared version. Under D-38 that is enforced by the guard job
  // rather than by the trigger, so these tests assert the guards directly. That is a stronger claim
  // than the one they replace, and deliberately so: relaxing a safety test without carrying its
  // intent forward is how a gate becomes decorative.
  describe("release workflow", () => {
    const raw = readFileSync(`${ROOT}/.github/workflows/release.yml`, "utf8");
    type Job = { needs?: string[]; permissions?: Record<string, string>; steps?: { run?: string; env?: Record<string, string>; with?: Record<string, string> }[] };
    const wf = parse(raw) as {
      on: { push?: { tags?: string[]; branches?: unknown }; pull_request?: unknown; workflow_dispatch?: { inputs?: Record<string, unknown> } };
      permissions: Record<string, string>;
      jobs: Record<string, Job>;
    };
    const guardRun = wf.jobs["guard"]?.steps?.map((s) => s.run ?? "").join("\n") ?? "";

    it("never triggers on a pull request, and the tag trigger is unchanged", () => {
      expect(wf.on.pull_request).toBeUndefined();
      expect(wf.on.push?.branches).toBeUndefined();
      expect(wf.on.push?.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+"]);
    });

    it("the dispatch path takes a version and nothing else", () => {
      // Any other input is a way to steer what gets published. The commit is resolved by the workflow,
      // never supplied by the caller.
      expect(Object.keys(wf.on.workflow_dispatch?.inputs ?? {})).toEqual(["version"]);
    });

    it("refuses a version that is not a bare semver", () => {
      expect(guardRun).toMatch(/\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
    });

    it("reads the version from the resolved commit, not the working tree", () => {
      // `git show <sha>:package.json` is the load-bearing detail: reading the checked-out file would
      // let a dispatch from another ref publish under a version that ref happens to declare.
      expect(guardRun).toMatch(/git show "\$\{SHA\}:package\.json"/);
      expect(guardRun).toMatch(/does not match package\.json/);
    });

    it("requires the released commit to be an ancestor of main", () => {
      // This is what makes the dispatch path unable to publish unreviewed code.
      expect(guardRun).toMatch(/git merge-base --is-ancestor "\$\{SHA\}" origin\/main/);
    });

    it("refuses to move an existing tag", () => {
      // A published version is immutable: compose pins it by digest, so re-pointing the tag would
      // change what an installed app resolves on its next pull.
      expect(guardRun).toMatch(/ls-remote --exit-code --tags origin "refs\/tags\/v\$\{VERSION\}"/);
      expect(guardRun).toMatch(/already exists/);
    });

    it("never interpolates the dispatch input into a shell body", () => {
      // ${{ }} splices into the script text before bash sees it, so a version string could carry
      // shell. The input must arrive through the environment instead.
      const runBodies = Object.values(wf.jobs).flatMap((j) => j.steps?.map((s) => s.run ?? "") ?? []);
      for (const body of runBodies) expect(body).not.toMatch(/\$\{\{\s*inputs\./);
      expect(wf.jobs["guard"]?.steps?.some((s) => s.env?.["INPUT_VERSION"] !== undefined)).toBe(true);
    });

    it("grants contents: write to exactly one job, and only after checks pass", () => {
      expect(wf.permissions["contents"]).toBe("read");
      const writers = Object.entries(wf.jobs).filter(([, j]) => j.permissions?.["contents"] === "write").map(([n]) => n);
      expect(writers).toEqual(["tag"]);
      // A tag created before the checks run would outlive a failed release, pointing at nothing.
      expect(wf.jobs["tag"]?.needs).toContain("checks");
    });

    it("builds and checks the resolved commit rather than the triggering ref", () => {
      // On the dispatch path github.sha is the dispatch ref, which is not necessarily what is being
      // released. Every job that touches source must pin the guard's resolved sha.
      for (const job of ["checks", "publish"]) {
        const refs = wf.jobs[job]?.steps?.map((s) => s.with?.["ref"]).filter(Boolean) ?? [];
        expect(refs, `${job} must check out the resolved sha`).toContain("${{ needs.guard.outputs.sha }}");
      }
      // The sha- image tag must name the released commit too, or the image is mislabelled.
      expect(raw).toMatch(/blackgold:sha-\$\{\{ needs\.guard\.outputs\.sha \}\}/);
      expect(raw).not.toMatch(/blackgold:sha-\$\{\{ github\.sha \}\}/);
    });
  });

  it("ci workflow never pushes an image", () => {
    const ci = readFileSync(`${ROOT}/.github/workflows/ci.yml`, "utf8");
    expect(ci).not.toMatch(/push:\s*true/);
    expect(ci).not.toMatch(/docker\/login-action/);
  });
});
