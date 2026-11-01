import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    expect(scripts()).toEqual(expect.arrayContaining(["bg", "bg-gateway", "d57-reconcile.sh", "eval-store.sh", "pi-benchmark.sh", "pi-update.sh", "stale-branches.sh"]));
  });

  it("every script parses (bash -n) and is executable", () => {
    for (const f of scripts()) {
      const path = join(PI, f);
      execFileSync("bash", ["-n", path]);
      expect(statSync(path).mode & 0o111, `${f} must be executable`).not.toBe(0);
    }
  });

  /** Each command in a line (`a && b`, `a; b`, `a | b`, `$(b)`) is checked on its own, so `sudo docker ps && docker rm x` fails. */
  function dockerWithoutSudo(line: string): string | undefined {
    for (const seg of line.split(/&&|\|\||;|\||\$\(|`/).map((s) => s.trim())) {
      if (/(^|\s)docker\s/.test(seg) && !/(^|\s)sudo(\s+-E|\s+--preserve-env=\S+)?\s+docker\s/.test(seg)) return seg;
    }
    return undefined;
  }

  it("every docker invocation carries sudo, and no script runs a host node against the app", () => {
    for (const f of scripts()) {
      const lines = readFileSync(join(PI, f), "utf8").split("\n");
      for (const [i, raw] of lines.entries()) {
        const line = raw.trim();
        if (line.startsWith("#") || line.length === 0) continue;
        const bare = dockerWithoutSudo(line);
        if (bare !== undefined) expect.fail(`${f}:${i + 1} runs docker without sudo: ${bare}`);
        if (/^node\s+packages\//.test(line) || line.includes('"$(dirname "$0")/../packages')) expect.fail(`${f}:${i + 1} runs a host node: ${line}`);
      }
    }
  });

  it("the sudo gate sees every command on a line, not only the first", () => {
    expect(dockerWithoutSudo("sudo docker ps && docker rm x")).toBe("docker rm x");
    expect(dockerWithoutSudo('docker cp "$f" c:/data/x')).toBe('docker cp "$f" c:/data/x');
    expect(dockerWithoutSudo("IMG=$(sudo docker inspect c --format '{{.Config.Image}}')")).toBeUndefined();
    expect(dockerWithoutSudo("sudo -E docker run --rm img")).toBeUndefined();
  });

  it("the Dockerfile ships scripts/pi so one docker cp installs them", () => {
    expect(readFileSync(join(ROOT, "Dockerfile"), "utf8")).toMatch(/COPY --chown=1000:1000 scripts\/pi \.\/scripts\/pi/);
  });

  it("the install line copies the directory's contents (trailing /.) so a re-run replaces the wrappers instead of nesting them", () => {
    for (const f of ["docs/runbooks/umbrel-install-update-remove.md", "docs/owner-queue.yaml", "scripts/pi/bg", "Dockerfile"]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect(text, f).toContain("docker cp blackgold-trading_core_1:/app/scripts/pi/. ~/bg");
      expect(text, f).not.toMatch(/docker cp blackgold-trading_core_1:\/app\/scripts\/pi ~\/bg/);
    }
  });

  it("pi-benchmark.sh uses sudo for docker (the umbrel user is refused the socket)", () => {
    const text = readFileSync(join(PI, "pi-benchmark.sh"), "utf8");
    for (const line of text.split("\n")) {
      if (/\bdocker (exec|stats)\b/.test(line)) expect(line, line).toMatch(/sudo docker/);
    }
  });

  it("d57-reconcile.sh takes four to six inputs and refuses any other count before touching anything (PR #120 round 1)", () => {
    for (const n of [3, 7]) {
      const r = spawnSync("bash", [join(PI, "d57-reconcile.sh"), ...Array.from({ length: n }, (_, i) => `f${i}.json`)], { encoding: "utf8" });
      expect(r.status, `${n} args`).toBe(2);
      expect(r.stderr, `${n} args`).toContain("usage:");
    }
  });

  it("pi-update.sh records health even when health reports ok=false (exit 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-update-"));
    try {
      writeFileSync(join(dir, "bg"), '#!/usr/bin/env bash\ncase "$1" in health) echo \'{"ok":false,"checks":[]}\'; exit 1;; backup) echo backed-up;; version) echo 0.0.0;; esac\n', { mode: 0o755 });
      writeFileSync(join(dir, "pi-update.sh"), readFileSync(join(PI, "pi-update.sh"), "utf8"), { mode: 0o755 });
      const r = spawnSync("bash", [join(dir, "pi-update.sh"), "before"], { encoding: "utf8", env: { ...process.env, BG_STATE_DIR: join(dir, "state") } });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("WARNING: health reports ok=false");
      expect(r.stdout).toContain("Then run: pi-update.sh after");
      expect(readFileSync(join(dir, "state/health-before.json"), "utf8")).toContain('"ok":false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

    const research = (dir: string): string => {
      const d = join(dir, "app-data", "blackgold-trading", "data");
      mkdirSync(d, { recursive: true });
      return d;
    };

    it("the research data directory, a directory inside it, or a directory that contains it", () => {
      withTmp((dir) => {
        const r = research(dir);
        writeFileSync(join(dir, "signed.json"), "{}");
        const same = run([r, join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: r, BG_IMAGE: "img" });
        expect(same.status).toBe(3);
        expect(same.out).toContain("research data directory");
        const inside = run([join(r, "eval"), join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: r, BG_IMAGE: "img" });
        expect(inside.status).toBe(3);
        const ancestor = run([join(dir, "app-data", "blackgold-trading"), join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: r, BG_IMAGE: "img" });
        expect(ancestor.status).toBe(3);
        expect(ancestor.out).toContain("contains the research data directory");
        const sibling = run([join(dir, "app-data", "blackgold-trading", "data-eval"), join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: r, BG_IMAGE: "img" });
        expect(sibling.status).toBe(0);
      });
    });

    it("a target that already exists and is not empty (an earlier attempt could leave observations behind; PR #120 round 1)", () => {
      withTmp((dir) => {
        const r0 = research(dir);
        writeFileSync(join(dir, "signed.json"), "{}");
        mkdirSync(join(dir, "eval-used"));
        writeFileSync(join(dir, "eval-used", "blackgold.sqlite"), "");
        const used = run([join(dir, "eval-used"), join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: r0, BG_IMAGE: "img" });
        expect(used.status).toBe(3);
        expect(used.out).toContain("not empty");
        mkdirSync(join(dir, "eval-empty"));
        const empty = run([join(dir, "eval-empty"), join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: r0, BG_IMAGE: "img" });
        expect(empty.status).toBe(0);
      });
    });

    it("a research directory that does not exist (the separation cannot be checked)", () => {
      withTmp((dir) => {
        writeFileSync(join(dir, "signed.json"), "{}");
        const r = run([join(dir, "eval"), join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: join(dir, "nowhere"), BG_IMAGE: "img" });
        expect(r.status).toBe(3);
        expect(r.out).toContain("not found");
      });
    });

    it("any argument naming a secrets file or mount, and any option other than --dry-run (nothing passes through to docker)", () => {
      withTmp((dir) => {
        const r0 = research(dir);
        writeFileSync(join(dir, "signed.json"), "{}");
        const secrets = run([join(dir, "eval"), join(dir, "signed.json"), "--dry-run", "-v", "/x/secrets:/run/secrets"], { BG_RESEARCH_DIR: r0, BG_IMAGE: "img" });
        expect(secrets.status).toBe(3);
        expect(secrets.out).toContain("secrets");
        const unknown = run([join(dir, "eval"), join(dir, "signed.json"), "--dryrun"], { BG_RESEARCH_DIR: r0, BG_IMAGE: "img" });
        expect(unknown.status).toBe(2);
        expect(unknown.out).toContain("unknown option");
        const volume = run([join(dir, "eval"), join(dir, "signed.json"), "-v", "/x:/y", "--dry-run"], { BG_RESEARCH_DIR: r0, BG_IMAGE: "img" });
        expect(volume.status).toBe(2);
        const first = run(["--dry-run", join(dir, "eval"), join(dir, "signed.json")], { BG_RESEARCH_DIR: r0, BG_IMAGE: "img" });
        expect(first.status).toBe(0);
      });
    });

    it("passes the two credentials by name only (value-less -e under sudo -E), never as NAME=value on the command line", () => {
      const text = readFileSync(script, "utf8");
      expect(text).toContain("-e BLACKGOLD_TIINGO_API_KEY \\");
      expect(text).toContain("-e BLACKGOLD_SEC_USER_AGENT_CONTACT \\");
      expect(text).not.toMatch(/BLACKGOLD_TIINGO_API_KEY=\$/);
      expect(text).toContain("sudo -E docker run");
    });

    it("never runs tiingo-actions, and runs ingest -> corporate-actions -> snapshot in that order, stopping before register", () => {
      const text = readFileSync(script, "utf8");
      for (const line of text.split("\n")) if (!line.trim().startsWith("#")) expect(line).not.toContain("tiingo-actions");
      withTmp((dir) => {
        const r0 = research(dir);
        writeFileSync(join(dir, "signed.json"), "{}");
        const r = run([join(dir, "eval"), join(dir, "signed.json"), "--dry-run"], { BG_RESEARCH_DIR: r0, BG_IMAGE: "img" });
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
