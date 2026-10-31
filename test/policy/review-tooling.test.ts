import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeReport, DEFAULT_SOFT_MS, DEFAULT_THRESHOLD_MS, main as slowMain } from "../../scripts/check-slow-tests.ts";
import { applyMutation, isMandatory, loadRecords, main as mutationsMain, recordsToVerify, verifyRecord, type MutationRecord } from "../../scripts/check-mutations.ts";
import { parse } from "yaml";
import { evaluateReviewState, MAX_EXTERNAL_ROUNDS, parseRoundTable, REQUIRED_CHECKS, REQUIRED_HEADINGS, type GitFacts, type PrFacts, type ReviewStateInput } from "../../scripts/check-review-state.ts";

/**
 * The review and test guardrails (D-59) are code, and this file proves each one refuses what it is there to
 * refuse. A guardrail that cannot fail is decoration.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const quiet = (): void => {
  /* swallow script output in tests */
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "bg-review-tooling-"));
}

// ---------------------------------------------------------------------------------------------------------

describe("check-slow-tests", () => {
  const report = (durations: number[]): { testResults: { name: string; assertionResults: { fullName: string; status: string; duration: number }[] }[] } => ({
    testResults: [{ name: "x.test.ts", assertionResults: durations.map((d, i) => ({ fullName: `t${i}`, status: "passed", duration: d })) }],
  });

  it("flags a test over the hard limit, warns between the soft target and the limit, lists the slowest first", () => {
    const a = analyzeReport(report([120, 12_000, 6_000, 300]), DEFAULT_THRESHOLD_MS, 10, DEFAULT_SOFT_MS);
    expect(a.total).toBe(4);
    expect(a.slow.map((t) => t.name)).toEqual(["t1"]);
    expect(a.warn.map((t) => t.name)).toEqual(["t2"]);
    expect(a.top[0]?.durationMs).toBe(12_000);
    expect(DEFAULT_THRESHOLD_MS).toBe(10_000);
    expect(DEFAULT_SOFT_MS).toBe(5_000);
  });

  it("a test exactly at the limit passes; one millisecond over fails", () => {
    expect(analyzeReport(report([10_000]), 10_000).slow).toEqual([]);
    expect(analyzeReport(report([10_001]), 10_000).slow).toHaveLength(1);
  });

  it("the CLI exits non-zero on a planted 12 s test and zero on a clean or merely warned report", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "slow.json"), JSON.stringify(report([12_000])));
      writeFileSync(join(dir, "warn.json"), JSON.stringify(report([6_000])));
      writeFileSync(join(dir, "ok.json"), JSON.stringify(report([10, 20])));
      const lines: string[] = [];
      expect(slowMain(["--report", join(dir, "slow.json")], dir, quiet)).toBe(1);
      expect(slowMain(["--report", join(dir, "warn.json")], dir, (l) => lines.push(l))).toBe(0);
      expect(lines.some((l) => l.startsWith("warn:"))).toBe(true);
      expect(slowMain(["--report", join(dir, "ok.json")], dir, quiet)).toBe(0);
      expect(slowMain(["--report", join(dir, "missing.json")], dir, quiet)).toBe(1);
      expect(slowMain(["--report", join(dir, "ok.json"), "--threshold-ms", "15", "--soft-ms", "15"], dir, quiet)).toBe(1);
      expect(() => slowMain(["--report", join(dir, "ok.json"), "--soft-ms", "20000"], dir, quiet)).toThrow(/soft-ms/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vitest writes the JSON report the gate reads, and every project carries the slow threshold", () => {
    const cfg = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(cfg).toMatch(/reporters:\s*\["default",\s*"json"\]/);
    expect(cfg).toMatch(/outputFile:\s*\{\s*json:\s*"\.vitest\/report\.json"\s*\}/);
    expect((cfg.match(/slowTestThreshold: SLOW_MS/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(cfg).toMatch(/SLOW_MS = 5_000/);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("check-mutations", () => {
  it("the mandatory set covers the financial paths and never a test file", () => {
    for (const f of [
      "packages/core/src/risk/orders.ts",
      "packages/core/src/decision/gate.ts",
      "packages/core/src/execution/paper-orders.ts",
      "packages/core/src/ledger/ledger.ts",
      "packages/core/src/research/nav.ts",
      "packages/core/src/research/stats.ts",
      "packages/core/src/strategy/construct.ts",
      "packages/core/src/data/adapters/corporate-actions.ts",
      "packages/core/src/data/adapters/corporate-actions-sign.ts",
      "packages/core/src/config/load.ts",
      "packages/broker-gateway/src/guards/hard-caps.ts",
    ]) {
      expect(isMandatory(f), f).toBe(true);
    }
    for (const f of ["packages/core/src/main.ts", "packages/core/src/status/render.ts", "packages/core/test/risk-orders.test.ts", "scripts/check-mutations.ts", "docs/STATE.md"]) {
      expect(isMandatory(f), f).toBe(false);
    }
  });

  it("applyMutation requires exactly one occurrence of `find`", () => {
    expect(applyMutation("a gt b", "gt", "gte")).toBe("a gte b");
    expect(() => applyMutation("a gt b gt c", "gt", "gte")).toThrow(/more than once/);
    expect(() => applyMutation("a gt b", "lt", "lte")).toThrow(/not present/);
    expect(() => applyMutation("a gt b", "gt", "gt")).toThrow(/identical/);
  });

  it("every tracked record parses, names an existing file and test, and its `find` is unique", () => {
    const records = loadRecords(join(ROOT, "test/mutations"));
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const r of records) {
      const source = readFileSync(join(ROOT, r.file), "utf8");
      for (const m of r.mutations) {
        expect(() => applyMutation(source, m.find, m.replace), `${r.source} [${m.name}]`).not.toThrow();
        expect(readFileSync(join(ROOT, m.test), "utf8").length, m.test).toBeGreaterThan(0);
        expect(isMandatory(r.file), `${r.file} should be in the mandatory set`).toBe(true);
      }
    }
  });

  it("a mutation the test catches is killed and the file is restored; one the test misses SURVIVES", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "test"));
      writeFileSync(join(dir, "src/guard.ts"), "export const ok = (x: number) => x > 10;\n");
      writeFileSync(join(dir, "test/guard.test.ts"), "// placeholder\n");
      const record: MutationRecord = {
        file: "src/guard.ts",
        source: "fixture",
        mutations: [{ name: "strict comparison", find: "x > 10", replace: "x >= 10", test: "test/guard.test.ts" }],
      };
      // A runner that "fails" (non-zero) when the mutated text is present: the test guards the invariant.
      const catching = (): number => (readFileSync(join(dir, "src/guard.ts"), "utf8").includes("x >= 10") ? 1 : 0);
      expect(verifyRecord(dir, record, catching, quiet)).toEqual([]);
      expect(readFileSync(join(dir, "src/guard.ts"), "utf8")).toContain("x > 10");
      // A runner that stays green no matter what: the mutation survives and the check fails.
      const blind = (): number => 0;
      const problems = verifyRecord(dir, record, blind, quiet);
      expect(problems).toEqual([expect.stringContaining("SURVIVED")]);
      expect(readFileSync(join(dir, "src/guard.ts"), "utf8")).toContain("x > 10");
      // A `find` that does not occur is reported, not skipped.
      const missing: MutationRecord = { ...record, mutations: record.mutations.map((m) => ({ ...m, find: "x > 99" })) };
      expect(verifyRecord(dir, missing, catching, quiet)).toEqual([expect.stringContaining("not present")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the CLI with --all verifies every record through the supplied runner and fails on a survivor", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "test"));
      mkdirSync(join(dir, "test/mutations"));
      writeFileSync(join(dir, "src/guard.ts"), "export const ok = (x: number) => x > 10;\n");
      writeFileSync(join(dir, "test/guard.test.ts"), "// placeholder\n");
      writeFileSync(join(dir, "test/mutations/guard.yaml"), "file: src/guard.ts\nmutations:\n  - name: strict\n    find: 'x > 10'\n    replace: 'x >= 10'\n    test: test/guard.test.ts\n");
      const catching = (): number => (readFileSync(join(dir, "src/guard.ts"), "utf8").includes("x >= 10") ? 1 : 0);
      expect(mutationsMain(["--all"], dir, quiet, catching)).toBe(0);
      expect(mutationsMain(["--all"], dir, quiet, () => 0)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a record is re-verified when its source, its YAML, or its guarding test changed (weakening the test alone cannot slip past)", () => {
    const root = "/repo";
    const record: MutationRecord = {
      file: "packages/core/src/risk/orders.ts",
      source: "/repo/test/mutations/risk-orders.yaml",
      mutations: [{ name: "n", find: "a", replace: "b", test: "packages/core/test/risk-orders.test.ts" }],
    };
    expect(recordsToVerify([record], ["packages/core/src/risk/orders.ts"], root)).toHaveLength(1);
    expect(recordsToVerify([record], ["test/mutations/risk-orders.yaml"], root)).toHaveLength(1);
    expect(recordsToVerify([record], ["packages/core/test/risk-orders.test.ts"], root)).toHaveLength(1);
    expect(recordsToVerify([record], ["packages/core/src/main.ts", "docs/STATE.md"], root)).toHaveLength(0);
  });

  it("the tracked record for risk/orders.ts targets the notional cap's strictness", () => {
    const raw = parse(readFileSync(join(ROOT, "test/mutations/risk-orders.yaml"), "utf8")) as { file: string; mutations: { find: string; replace: string }[] };
    expect(raw.file).toBe("packages/core/src/risk/orders.ts");
    expect(raw.mutations[0]?.find).toContain("notional.gt(notionalCap)");
    expect(raw.mutations[0]?.replace).toContain("notional.gte(notionalCap)");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("check-review-state", () => {
  const HEAD = "a".repeat(40);
  const bodyWith = (rounds: string[], knownOpen = "none"): string =>
    [
      "## Scope",
      "x",
      "## Requirements coverage",
      "x",
      "## Financial and security risk",
      "x",
      "## Migrations",
      "x",
      "## Rollback",
      "x",
      "## Tests",
      "x",
      "## Review rounds",
      "| Round | Head SHA | Reviewer | Outcome |",
      "|---|---|---|---|",
      ...rounds,
      "## Mutation check",
      "x",
      "## Known open findings",
      knownOpen,
      "## Resource impact",
      "x",
      "## Deferred items",
      "x",
      "## Live-trading statement",
      "Live trading remains disabled by construction.",
    ].join("\n");

  const pr = (over: Partial<PrFacts> = {}): PrFacts => ({
    number: 118,
    headSha: HEAD,
    baseRef: "main",
    isDraft: false,
    body: bodyWith(["| 1 | " + HEAD + " | codex | fixed |"]),
    checks: REQUIRED_CHECKS.map((name) => ({ name, conclusion: "success" })),
    botReviewComments: [{ createdAt: "2026-11-02T15:00:00Z", commitSha: HEAD }],
    headCommittedAt: "2026-11-02T14:00:00Z",
    ...over,
  });
  const git = (over: Partial<GitFacts> = {}): GitFacts => ({
    localHeadSha: HEAD,
    dirtyTrackedFiles: [],
    unpushedCommits: 0,
    changedFiles: ["packages/core/src/main.ts"],
    isAncestorOfHead: (sha) => sha === HEAD || sha === "b".repeat(40),
    policyFloor: { base: 47, head: 47 },
    ...over,
  });
  const ledger = (rows = ""): string => "| PR | SHA | Reviewer | Finding | Severity | Category | Target rung | Status | Resolution |\n|---|---|---|---|---|---|---|---|---|\n" + rows;
  const input = (p: Partial<PrFacts> = {}, g: Partial<GitFacts> = {}, rows = "", extra: Partial<ReviewStateInput> = {}): ReviewStateInput => ({
    pr: pr(p),
    git: git(g),
    knownFindingsMarkdown: ledger(rows),
    maxExternalRounds: MAX_EXTERNAL_ROUNDS,
    ...extra,
  });

  it("a clean, pushed, reviewed, green PR passes", () => {
    expect(evaluateReviewState(input())).toEqual([]);
  });

  it("an unpushed commit or a dirty tree blocks (the never-pushed fix incident)", () => {
    expect(evaluateReviewState(input({}, { unpushedCommits: 1 }))).toEqual([expect.stringContaining("not pushed")]);
    expect(evaluateReviewState(input({}, { unpushedCommits: undefined }))).toEqual([expect.stringContaining("no upstream")]);
    expect(evaluateReviewState(input({}, { dirtyTrackedFiles: ["x.ts"] }))).toEqual([expect.stringContaining("modified tracked files")]);
  });

  it("local HEAD must be the PR head, and a round citing a sha not on the PR is refused", () => {
    expect(evaluateReviewState(input({}, { localHeadSha: "c".repeat(40) }))).toEqual([expect.stringContaining("not the PR head")]);
    const body = bodyWith(["| 1 | " + "d".repeat(40) + " | codex | fixed |"]);
    expect(evaluateReviewState(input({ body }))).toEqual([expect.stringContaining("not reachable from the PR head")]);
  });

  it("a fourth external round needs a known-findings row for this PR or an explicit 'none'", () => {
    const rounds = [1, 2, 3, 4].map((n) => `| ${n} | ${HEAD} | codex | partial |`);
    const over = bodyWith(rounds, "see ledger");
    expect(evaluateReviewState(input({ body: over }))).toEqual([expect.stringContaining("exceed the budget")]);
    const withRow = `| #118 | ${HEAD.slice(0, 12)} | codex | status page omits halt state | P2 | ergonomics | rung-3 | open | |\n`;
    expect(evaluateReviewState(input({ body: bodyWith(rounds, "status page omits halt state") }, {}, withRow))).toEqual([]);
    expect(evaluateReviewState(input({ body: bodyWith(rounds, "none") }))).toEqual([]);
    // Self-review rounds do not count against the external budget.
    const selfRounds = [1, 2, 3].map((n) => `| ${n} | ${HEAD} | codex | partial |`).concat(["| 4 | " + HEAD + " | self | partial |"]);
    expect(evaluateReviewState(input({ body: bodyWith(selfRounds) }))).toEqual([]);
  });

  it("an open floor P1 in the ledger blocks regardless of rounds, and an unmentioned open row is reported", () => {
    const floorRow = `| #118 | ${HEAD.slice(0, 12)} | codex | gte at the cap | P1 | money-arithmetic | next-pr | open | |\n`;
    const problems = evaluateReviewState(input({}, {}, floorRow));
    expect(problems.some((p) => p.includes("blocks merge"))).toBe(true);
    expect(problems.some((p) => p.includes("does not mention it"))).toBe(true);
  });

  it("CI must be green on the head and every template heading must be present", () => {
    const [checksJob, imageJob] = REQUIRED_CHECKS;
    expect(evaluateReviewState(input({ checks: [{ name: checksJob, conclusion: "success" }] }))).toEqual([expect.stringContaining(`"${imageJob}" has not reported`)]);
    expect(evaluateReviewState(input({ checks: [{ name: checksJob, conclusion: "failure" }, { name: imageJob, conclusion: "success" }] }))).toEqual([expect.stringContaining("is failure")]);
    const missing = pr().body.replace("## Rollback\nx\n", "");
    expect(evaluateReviewState(input({ body: missing }))).toEqual([expect.stringContaining('"## Rollback"')]);
    expect(REQUIRED_HEADINGS).toContain("## Review rounds");
    expect(REQUIRED_HEADINGS).toContain("## Known open findings");
  });

  it("a round in flight blocks: an external review must name the head commit, not merely postdate it", () => {
    // A late review of the PREVIOUS head postdates the current commit and must still block (Codex P1, round 1).
    const prev = "b".repeat(40);
    expect(evaluateReviewState(input({ botReviewComments: [{ createdAt: "2026-11-02T15:00:00Z", commitSha: prev }] }))).toEqual([expect.stringContaining("no external review names the head commit")]);
    expect(evaluateReviewState(input({ botReviewComments: [{ createdAt: "2026-11-02T13:00:00Z", commitSha: prev }, { createdAt: "2026-11-02T15:00:00Z", commitSha: HEAD }] }))).toEqual([]);
    // Without a commit sha only the timestamp is available: an older comment blocks, a newer one is still reported as weak evidence.
    expect(evaluateReviewState(input({ botReviewComments: [{ createdAt: "2026-11-02T13:00:00Z" }] }))).toEqual([expect.stringContaining("has not completed")]);
    expect(evaluateReviewState(input({ botReviewComments: [{ createdAt: "2026-11-02T15:00:00Z" }] }))).toEqual([expect.stringContaining("carry no commitSha")]);
    expect(evaluateReviewState(input({ botReviewComments: [] }))).toEqual([expect.stringContaining("no external review comment")]);
    expect(evaluateReviewState(input({ botReviewComments: [] }, {}, "", { noExternalReviewReason: "Codex rate-limited; non-financial path" }))).toEqual([]);
  });

  it("the no-external-review bypass is refused when a financial-critical file changed", () => {
    const financial = { changedFiles: ["packages/core/src/risk/orders.ts", "docs/x.md"] };
    const bypass = { noExternalReviewReason: "Codex rate-limited" };
    expect(evaluateReviewState(input({ botReviewComments: [] }, financial, "", bypass))).toEqual([expect.stringContaining("--no-external-review is refused")]);
    expect(evaluateReviewState(input({ botReviewComments: [] }, { changedFiles: ["packages/broker-gateway/src/guards/gateway.ts"] }, "", bypass))).toEqual([expect.stringContaining("--no-external-review is refused")]);
    expect(evaluateReviewState(input({ botReviewComments: [] }, { changedFiles: ["packages/core/src/status/render.ts"] }, "", bypass))).toEqual([]);
  });

  it("moving a gate needs a decision on record, and the policy floor only rises", () => {
    expect(evaluateReviewState(input({}, { changedFiles: ["test/policy/live-disabled.test.ts"] }))).toEqual([expect.stringContaining("cites no decision")]);
    const cited = pr().body + "\nAmends the gate under D-63.";
    expect(evaluateReviewState(input({ body: cited }, { changedFiles: ["test/policy/live-disabled.test.ts"] }))).toEqual([]);
    expect(evaluateReviewState(input({}, { policyFloor: { base: 47, head: 46 } }))).toEqual([expect.stringContaining("only rises")]);
    expect(evaluateReviewState(input({ baseRef: "claude/other" }))).toEqual([expect.stringContaining("not main")]);
    expect(evaluateReviewState(input({ isDraft: true }))).toEqual([expect.stringContaining("draft")]);
  });

  it("parses the round table and ignores the template's empty row", () => {
    const t = parseRoundTable(bodyWith(["| | | | |", "| 1 | " + HEAD + " | codex | fixed |", "| x | abc | codex | ? |"]));
    expect(t.rows).toHaveLength(1);
    expect(t.errors).toEqual([expect.stringContaining("not a round number")]);
  });

  it("the CLI prints the PR JSON shape for a cloud session without gh", () => {
    const out = execFileSync("node", ["scripts/check-review-state.ts", "--print-shape"], { cwd: ROOT, encoding: "utf8" });
    const shape = JSON.parse(out) as PrFacts;
    expect(shape.checks.map((c) => c.name)).toEqual([...REQUIRED_CHECKS]);
  });

  it("the required check names are the CI workflow's job names (GitHub reports runs by name, not id)", () => {
    const ci = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { name?: string }> };
    expect(ci.jobs["checks"]?.name).toBe(REQUIRED_CHECKS[0]);
    expect(ci.jobs["image"]?.name).toBe(REQUIRED_CHECKS[1]);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("the guardrails are wired into the repository", () => {
  it("npm run check runs the slow-test and mutation gates", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:slow"]).toMatch(/check-slow-tests\.ts/);
    expect(pkg.scripts["check:mutations"]).toMatch(/check-mutations\.ts/);
    expect(pkg.scripts["check:review"]).toMatch(/check-review-state\.ts/);
    expect(pkg.scripts["check"]).toMatch(/check:slow/);
    expect(pkg.scripts["check"]).toMatch(/check:mutations/);
  });

  it("CI runs both gates after the tests", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const testAt = ci.indexOf("npm run test");
    expect(testAt).toBeGreaterThan(0);
    expect(ci.indexOf("npm run check:slow")).toBeGreaterThan(testAt);
    expect(ci.indexOf("npm run check:mutations")).toBeGreaterThan(testAt);
  });

  it("the PR template carries the review-rounds, mutation-check and known-findings sections", () => {
    const tpl = readFileSync(join(ROOT, ".github/pull_request_template.md"), "utf8");
    for (const h of REQUIRED_HEADINGS) expect(tpl.split("\n").map((l) => l.trim()), h).toContain(h);
  });

  it("the review rules file is path-scoped to the code and test trees", () => {
    const rules = readFileSync(join(ROOT, ".claude/rules/review-and-tests.md"), "utf8");
    expect(rules).toMatch(/packages\/\*\*/);
    expect(rules).toMatch(/test\/\*\*/);
    expect(rules).toMatch(/three external review rounds/i);
    expect(rules).toMatch(/KNOWN_FINDINGS/);
  });
});
