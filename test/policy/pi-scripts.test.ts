import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Pi wrappers under scripts/pi are the owner's pastes (D-60). Every one must parse, every docker call must
 * carry sudo, none may run a host `node`, and eval-store.sh must refuse the three things that would taint the
 * evaluation store (D-57(b)).
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PI = join(ROOT, "scripts/pi");

function scripts(): string[] {
  return readdirSync(PI)
    .filter((f) => statSync(join(PI, f)).isFile())
    .sort();
}

describe("scripts/pi", () => {
  it("ships the wrappers the queue and the runbooks name", () => {
    expect(scripts()).toEqual(expect.arrayContaining(["bg", "bg-gateway", "d57-reconcile.sh", "eval-store.sh", "pi-update.sh", "stale-branches.sh"]));
  });

  it("every script parses (bash -n) and is executable", () => {
    for (const f of scripts()) {
      const path = join(PI, f);
      execFileSync("bash", ["-n", path]);
      expect(statSync(path).mode & 0o111, `${f} must be executable`).not.toBe(0);
    }
  });

  it("every docker invocation carries sudo, and no script runs a host node against the app", () => {
    for (const f of scripts()) {
      const lines = readFileSync(join(PI, f), "utf8").split("\n");
      for (const [i, raw] of lines.entries()) {
        const line = raw.trim();
        if (line.startsWith("#") || line.length === 0) continue;
        if (/(^|[^\w-])docker\s/.test(line) && !line.includes("sudo docker") && !line.includes("docker cp")) {
          expect.fail(`${f}:${i + 1} runs docker without sudo: ${line}`);
        }
        if (/^node\s+packages\//.test(line) || line.includes('"$(dirname "$0")/../packages')) expect.fail(`${f}:${i + 1} runs a host node: ${line}`);
      }
    }
  });

  it("the Dockerfile ships scripts/pi so one docker cp installs them", () => {
    expect(readFileSync(join(ROOT, "Dockerfile"), "utf8")).toMatch(/COPY --chown=1000:1000 scripts\/pi \.\/scripts\/pi/);
  });

  it("pi-benchmark.sh uses sudo for docker (the umbrel user is refused the socket)", () => {
    const text = readFileSync(join(ROOT, "scripts/pi-benchmark.sh"), "utf8");
    for (const line of text.split("\n")) {
      if (/\bdocker (exec|stats)\b/.test(line)) expect(line, line).toMatch(/sudo docker/);
    }
  });

  describe("eval-store.sh refuses what would taint the evaluation store", () => {
    const script = join(PI, "eval-store.sh");
    const run = (args: string[], env: Record<string, string>): { status: number; out: string } => {
      const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
      return { status: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
    };
    const withTmp = (fn: (dir: string) => void): void => {
      const dir = mkdtempSync(join(tmpdir(), "bg-eval-"));
      try {
        fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("the research data directory, or a directory inside it", () => {
      withTmp((dir) => {
        const research = join(dir, "data");
        writeFileSync(join(dir, "signed.json"), "{}");
        const same = run([research, join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: research, BG_IMAGE: "img" });
        expect(same.status).toBe(3);
        expect(same.out).toContain("research data directory");
        const inside = run([join(research, "eval"), join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: research, BG_IMAGE: "img" });
        expect(inside.status).toBe(3);
      });
    });

    it("any argument naming a secrets file or mount", () => {
      withTmp((dir) => {
        writeFileSync(join(dir, "signed.json"), "{}");
        const r = run([join(dir, "eval"), join(dir, "signed.json"), "--dry-run", "-v", "/x/secrets:/run/secrets"], { BG_RESEARCH_DIR: join(dir, "data"), BG_IMAGE: "img" });
        expect(r.status).toBe(3);
        expect(r.out).toContain("secrets");
      });
    });

    it("never runs tiingo-actions, and runs ingest -> corporate-actions -> snapshot in that order, stopping before register", () => {
      const text = readFileSync(script, "utf8");
      for (const line of text.split("\n")) if (!line.trim().startsWith("#")) expect(line).not.toContain("tiingo-actions");
      withTmp((dir) => {
        writeFileSync(join(dir, "signed.json"), "{}");
        const r = run([join(dir, "eval"), join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: join(dir, "data"), BG_IMAGE: "img" });
        expect(r.status).toBe(0);
        const bars = r.out.indexOf("ingest universe");
        const actions = r.out.indexOf("ingest corporate-actions --file /data/signed.json");
        const snapshot = r.out.indexOf("snapshot create");
        expect(bars).toBeGreaterThan(0);
        expect(actions).toBeGreaterThan(bars);
        expect(snapshot).toBeGreaterThan(actions);
        expect(r.out).toContain("--actions none");
        expect(r.out).toContain("STOP. Registration is yours.");
        expect(r.out).not.toMatch(/^== experiment register/m);
      });
    });
  });
});
