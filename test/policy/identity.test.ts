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

  it("release workflow runs only on semver tags and never on pull requests", () => {
    const wf = parse(readFileSync(`${ROOT}/.github/workflows/release.yml`, "utf8")) as {
      on: { push?: { tags?: string[]; branches?: unknown }; pull_request?: unknown; workflow_dispatch?: unknown };
    };
    expect(wf.on.pull_request).toBeUndefined();
    expect(wf.on.workflow_dispatch).toBeUndefined();
    expect(wf.on.push?.branches).toBeUndefined();
    expect(wf.on.push?.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+"]);
  });

  it("ci workflow never pushes an image", () => {
    const ci = readFileSync(`${ROOT}/.github/workflows/ci.yml`, "utf8");
    expect(ci).not.toMatch(/push:\s*true/);
    expect(ci).not.toMatch(/docker\/login-action/);
  });
});
