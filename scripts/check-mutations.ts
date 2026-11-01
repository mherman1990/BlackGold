#!/usr/bin/env node
/**
 * Mutation records, verified rather than self-reported.
 *
 * STATE.md records that four of eleven review rounds on one PR introduced a defect while the guarding test
 * stayed green, and that seven tests across two PRs certified behaviour they could not detect. The standing
 * rule since then is "delete the behaviour and confirm the test fails" for every guard on a financial
 * invariant. Until now the evidence was a sentence in a PR body ("16 of 16 faults caught") that nobody could
 * re-run. This script makes the record executable:
 *
 *   test/mutations/<name>.yaml
 *     file: packages/core/src/risk/orders.ts
 *     mutations:
 *       - name: notional cap must be strict
 *         find: "if (notional.gt(notionalCap))"        # must occur exactly once in the file
 *         replace: "if (notional.gte(notionalCap))"
 *         test: packages/core/test/risk-orders.test.ts
 *         testName: "notional: at 1500 USD passes"      # optional `-t` filter
 *
 * For every source file changed against the base ref (default origin/main) that falls in the MANDATORY set
 * below, a record must exist, or the check fails. Every mutation in a record whose file changed (or every
 * record with --all) is then applied to a copy of the file in place, the named test is run, and the run
 * must go RED. The original bytes are restored whatever happens. A mutation the test does not catch is a
 * failure, because that test is not guarding what it claims.
 *
 * Optional outside the mandatory set: CLI plumbing, rendering, docs and scripts do not need records.
 *
 *   node scripts/check-mutations.ts [--base origin/main] [--all] [--records test/mutations]
 *                                   [--runner "<cmd with {test} and {name}>"]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * Files whose guards protect money, time, accounts, order lifecycle, compliance or fail-closed behaviour.
 * Compliance and the temporal read paths (lag rules, point-in-time repository, series, calendars, universe
 * snapshots) joined the set after PR #118's verification round found them missing.
 */
export const MANDATORY_PATTERNS: readonly RegExp[] = [
  /^packages\/core\/src\/risk\/.+\.ts$/,
  /^packages\/core\/src\/decision\/.+\.ts$/,
  /^packages\/core\/src\/execution\/.+\.ts$/,
  /^packages\/core\/src\/live\/.+\.ts$/,
  /^packages\/core\/src\/ledger\/.+\.ts$/,
  /^packages\/core\/src\/compliance\/.+\.ts$/,
  /^packages\/core\/src\/research\/(nav|stats|aggregate|simulator)\.ts$/,
  /^packages\/core\/src\/strategy\/construct\.ts$/,
  /^packages\/core\/src\/data\/adapters\/corporate-actions[^/]*\.ts$/,
  /^packages\/core\/src\/data\/(lag-rules|quality)\.ts$/,
  /^packages\/core\/src\/data\/pit\/.+\.ts$/,
  /^packages\/core\/src\/market\/.+\.ts$/,
  /^packages\/core\/src\/calendar\/.+\.ts$/,
  /^packages\/core\/src\/universe\/.+\.ts$/,
  /^packages\/core\/src\/config\/load\.ts$/,
  // The owner's registration path: every guard here protects the evidence record (B1).
  /^packages\/core\/src\/research\/experiment-cli\.ts$/,
  /^packages\/broker-gateway\/src\/.+\.ts$/,
];

export type Mutation = { name: string; find: string; replace: string; test: string; testName?: string };
export type MutationRecord = { file: string; mutations: Mutation[]; source: string };

export function isMandatory(file: string): boolean {
  if (/\.test\.ts$/.test(file)) return false;
  return MANDATORY_PATTERNS.some((re) => re.test(file));
}

/**
 * Changed files in the mandatory set that still exist. A source deleted together with its record leaves no
 * guard to require (PR #119 round 2); a source deleted while its record remains is caught by `verifyRecord`.
 */
export function mandatoryChangedFiles(changed: readonly string[], exists: (file: string) => boolean = () => true): string[] {
  return changed.filter((f) => isMandatory(f) && exists(f));
}

/**
 * Which records to verify for a set of changed files: a record whose source file changed, whose YAML record
 * changed, or whose named test file changed. The last two matter as much as the first: a PR can weaken the
 * guarding test, or edit the record itself, without touching the source (Codex P1, round 1). Pure.
 */
export function recordsToVerify(records: readonly MutationRecord[], changed: readonly string[], root: string): MutationRecord[] {
  const changedSet = new Set(changed);
  return records.filter((r) => {
    if (changedSet.has(r.file)) return true;
    const recordRel = r.source.startsWith(root + "/") ? r.source.slice(root.length + 1) : r.source;
    if (changedSet.has(recordRel)) return true;
    return r.mutations.some((m) => changedSet.has(m.test));
  });
}

/** Pure: replaces `find` with `replace`, refusing unless `find` occurs exactly once. */
export function applyMutation(content: string, find: string, replace: string): string {
  if (find.length === 0) throw new Error("mutation `find` is empty");
  if (find === replace) throw new Error("mutation `find` and `replace` are identical; nothing is mutated");
  const first = content.indexOf(find);
  if (first < 0) throw new Error(`mutation \`find\` not present in file: ${JSON.stringify(find)}`);
  if (content.indexOf(find, first + find.length) >= 0) throw new Error(`mutation \`find\` occurs more than once; make it unique: ${JSON.stringify(find)}`);
  return content.slice(0, first) + replace + content.slice(first + find.length);
}

function asRecord(raw: unknown, source: string): MutationRecord {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: record is not a mapping`);
  const r = raw as { file?: unknown; mutations?: unknown };
  if (typeof r.file !== "string" || r.file.length === 0) throw new Error(`${source}: \`file\` is required`);
  if (!Array.isArray(r.mutations) || r.mutations.length === 0) throw new Error(`${source}: \`mutations\` must be a non-empty list`);
  const mutations: Mutation[] = r.mutations.map((m: unknown, i: number) => {
    if (typeof m !== "object" || m === null) throw new Error(`${source}: mutation ${i} is not a mapping`);
    const mm = m as Record<string, unknown>;
    for (const k of ["name", "find", "replace", "test"]) {
      if (typeof mm[k] !== "string" || (mm[k] as string).length === 0) throw new Error(`${source}: mutation ${i} needs a non-empty \`${k}\``);
    }
    const out: Mutation = { name: mm["name"] as string, find: mm["find"] as string, replace: mm["replace"] as string, test: mm["test"] as string };
    if (mm["testName"] !== undefined) {
      if (typeof mm["testName"] !== "string") throw new Error(`${source}: mutation ${i} \`testName\` must be a string`);
      out.testName = mm["testName"];
    }
    return out;
  });
  return { file: r.file, mutations, source };
}

export function loadRecords(dir: string): MutationRecord[] {
  if (!existsSync(dir)) return [];
  const out: MutationRecord[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const source = join(dir, entry);
    out.push(asRecord(parse(readFileSync(source, "utf8")), source));
  }
  const seen = new Map<string, string>();
  for (const r of out) {
    const prior = seen.get(r.file);
    if (prior !== undefined) throw new Error(`${r.source} and ${prior} both record ${r.file}; keep one record per file`);
    seen.set(r.file, r.source);
  }
  return out;
}

/**
 * What one test run reported. `ranTests`/`failedTests` come from vitest's JSON report when the runner can
 * produce one; a runner that cannot leaves them undefined and only the exit code is known.
 */
export type RunResult = { exitCode: number; ranTests?: number; failedTests?: number };
export type Runner = (test: string, testName: string | undefined) => RunResult;

/**
 * Applies each mutation of `record` to the file on disk, runs the named test through `runner`, and expects an
 * ASSERTION to fail. Restores the original bytes in `finally`. Returns one problem string per surviving or
 * unproven mutation, or per malformed mutation.
 *
 * Two runs per mutation. The baseline (unmodified source) must be green and must have run at least one test,
 * so a misspelled filter cannot pass as a kill (Codex P1, round 2). The mutated run must report at least one
 * FAILED assertion: a non-zero exit with none (a syntax error the replacement introduced, an import error, a
 * runner crash) proves nothing about the guard and is reported, never counted (Codex P1, round 3).
 */
export function verifyRecord(root: string, record: MutationRecord, runner: Runner, log: (line: string) => void): string[] {
  const problems: string[] = [];
  const path = join(root, record.file);
  if (!existsSync(path)) return [`${record.source}: ${record.file} does not exist`];
  const original = readFileSync(path, "utf8");
  for (const m of record.mutations) {
    let mutated: string;
    try {
      mutated = applyMutation(original, m.find, m.replace);
    } catch (err) {
      problems.push(`${record.source} [${m.name}]: ${(err as Error).message}`);
      continue;
    }
    const testPath = join(root, m.test);
    if (!existsSync(testPath)) {
      problems.push(`${record.source} [${m.name}]: test file ${m.test} does not exist`);
      continue;
    }
    // The same file and filter must be GREEN on the unmodified source first. A misspelled `testName` selects no
    // tests and vitest exits non-zero, which would otherwise read as a kill (Codex P1, round 2).
    const label = `${m.test}${m.testName ? ` -t "${m.testName}"` : ""}`;
    const baseline = runner(m.test, m.testName);
    if (baseline.exitCode !== 0 || baseline.ranTests === 0 || (baseline.failedTests ?? 0) > 0) {
      problems.push(`${record.source} [${m.name}]: ${label} is not green on the unmodified source (exit ${baseline.exitCode}, ran ${baseline.ranTests ?? "?"}, failed ${baseline.failedTests ?? "?"}); the filter matches no test, or the test is already red`);
      continue;
    }
    try {
      writeFileSync(path, mutated);
      const run = runner(m.test, m.testName);
      if (run.exitCode === 0 && (run.failedTests ?? 0) === 0) {
        problems.push(`${record.source} [${m.name}]: SURVIVED - ${label} stayed green with the mutation applied; that test does not guard this invariant`);
      } else if (run.failedTests === undefined ? false : run.failedTests === 0) {
        problems.push(`${record.source} [${m.name}]: ${label} errored without a failing assertion (exit ${run.exitCode}); the mutation broke the run (syntax, import, runner), which proves nothing about the guard`);
      } else {
        log(`  killed: ${record.file} [${m.name}] -> ${label} went red (exit ${run.exitCode}, failed assertions ${run.failedTests ?? "unknown"})`);
      }
    } finally {
      writeFileSync(path, original);
    }
  }
  return problems;
}

/** Counts tests run and failed in a vitest JSON report. Pure. */
export function countReport(report: { testResults?: { assertionResults?: { status?: string }[] }[] }): { ranTests: number; failedTests: number } {
  let ranTests = 0;
  let failedTests = 0;
  for (const file of report.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      if (a.status === "pending" || a.status === "skipped" || a.status === "todo") continue;
      ranTests += 1;
      if (a.status === "failed") failedTests += 1;
    }
  }
  return { ranTests, failedTests };
}

export function vitestRunner(root: string, template?: string): Runner {
  return (test, testName) => {
    if (template !== undefined) {
      const cmd = template.replaceAll("{test}", test).replaceAll("{name}", testName ?? "");
      const r = spawnSync("sh", ["-c", cmd], { cwd: root, stdio: "ignore" });
      return { exitCode: r.status ?? 1 };
    }
    // `--reporter` on the command line replaces the configured reporters, so these runs do not overwrite the
    // JSON report `check-slow-tests` reads from the full `npm run test`; they write their own to a temp file,
    // which is how a failing ASSERTION is told apart from a run that errored.
    const dir = mkdtempSync(join(tmpdir(), "bg-mutation-"));
    const reportPath = join(dir, "report.json");
    try {
      const args = ["vitest", "run", "--reporter=json", `--outputFile=${reportPath}`, test];
      if (testName !== undefined) args.push("-t", testName);
      const r = spawnSync("npx", args, { cwd: root, stdio: "ignore" });
      const exitCode = r.status ?? 1;
      if (!existsSync(reportPath)) return { exitCode, ranTests: 0, failedTests: 0 };
      const counts = countReport(JSON.parse(readFileSync(reportPath, "utf8")) as Parameters<typeof countReport>[0]);
      return { exitCode, ...counts };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** A record as it existed on the base ref: its path and the source file it protected. */
export type BaseRecord = { path: string; file: string };

/**
 * Source files that a record protected on the base ref and that no record protects now, while the file still
 * exists. Deleting a record, or retargeting its `file` to another source, is deleting a guard; both are
 * refused unless the source went with it (PR #118 verification round; PR #119 round 1). The comparison is by
 * protected FILE, not by record path, so a renamed YAML that still names the same source is fine. Pure.
 */
export function deletedRecordProblems(baseRecords: readonly BaseRecord[], currentRecords: readonly { file: string }[], sourceExists: (file: string) => boolean): string[] {
  const protectedNow = new Set(currentRecords.map((r) => r.file));
  const out: string[] = [];
  for (const r of baseRecords) {
    if (protectedNow.has(r.file)) continue;
    if (sourceExists(r.file)) out.push(`${r.path} protected ${r.file} on the base ref; no record protects it now and the file still exists. A guard is only removed together with the file it guards`);
  }
  return out;
}

/** The record inventory at the merge-base with `base`, or undefined when the base cannot be resolved. */
export function baseRecordInventory(root: string, base: string, recordsDir: string): BaseRecord[] | undefined {
  try {
    const mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const listing = spawnSync("git", ["ls-tree", "--name-only", mergeBase, `${recordsDir}/`], { cwd: root, encoding: "utf8" });
    if (listing.status !== 0) return [];
    const out: BaseRecord[] = [];
    for (const path of listing.stdout.split("\n").map((s) => s.trim()).filter((p) => /\.ya?ml$/.test(p))) {
      const raw = execFileSync("git", ["show", `${mergeBase}:${path}`], { cwd: root, encoding: "utf8" });
      const parsed = parse(raw) as { file?: unknown };
      if (typeof parsed.file === "string") out.push({ path, file: parsed.file });
    }
    return out;
  } catch {
    return undefined;
  }
}

export function changedFilesAgainst(root: string, base: string): string[] | undefined {
  try {
    const mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const committed = execFileSync("git", ["diff", "--name-only", mergeBase, "HEAD"], { cwd: root, encoding: "utf8" });
    const working = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: root, encoding: "utf8" });
    return [...new Set(`${committed}\n${working}`.split("\n").map((s) => s.trim()).filter(Boolean))].sort();
  } catch {
    return undefined;
  }
}

type Args = { base: string; all: boolean; records: string; runner?: string };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { base: "origin/main", all: false, records: "test/mutations" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a ?? ""} needs a value`);
      return v;
    };
    if (a === "--base") args.base = next();
    else if (a === "--all") args.all = true;
    else if (a === "--records") args.records = next();
    else if (a === "--runner") args.runner = next();
    else throw new Error(`unknown argument ${a ?? ""}`);
  }
  return args;
}

export function main(argv: readonly string[], root: string, out: (line: string) => void, runnerOverride?: Runner, inventoryOverride?: BaseRecord[]): number {
  const args = parseArgs(argv);
  const records = loadRecords(join(root, args.records));
  const byFile = new Map(records.map((r) => [r.file, r] as const));
  const problems: string[] = [];

  // The guard-removal check runs in BOTH modes (PR #119 round 1): a record deleted or retargeted away from a
  // source that still exists is refused whether the run is diff-scoped or --all.
  const inventory = inventoryOverride ?? baseRecordInventory(root, args.base, args.records);
  if (inventory === undefined) {
    const msg = `mutation check: the record inventory at ${args.base} could not be read, so a removed guard cannot be detected`;
    if (process.env["CI"]) {
      out(`${msg}; in CI this is a failure`);
      return 1;
    }
    out(`${msg}; continuing without that check`);
  } else {
    problems.push(...deletedRecordProblems(inventory, records, (file) => existsSync(join(root, file))));
  }

  let toVerify: MutationRecord[];
  if (args.all) {
    toVerify = records;
  } else {
    const changed = changedFilesAgainst(root, args.base);
    if (changed === undefined) {
      const msg = `mutation check: base ref ${args.base} is not available, so changed files cannot be determined`;
      if (process.env["CI"]) {
        out(`${msg}; in CI this is a failure (fetch-depth must include the base)`);
        return 1;
      }
      out(`${msg}; skipping (run with --all to verify every record)`);
      return 0;
    }
    const mandatory = mandatoryChangedFiles(changed, (f) => existsSync(join(root, f)));
    for (const f of mandatory) {
      if (!byFile.has(f)) problems.push(`${f} changed and sits in the mandatory set but has no record under ${args.records}/`);
    }
    toVerify = recordsToVerify(records, changed, root);
    out(`mutation check: ${changed.length} changed file(s) against ${args.base}, ${mandatory.length} in the mandatory set, ${toVerify.length} record(s) to verify (source, record or guarding test changed)`);
  }

  const runner = runnerOverride ?? vitestRunner(root, args.runner);
  for (const record of toVerify) {
    out(`verifying ${record.file} (${record.mutations.length} mutation(s))`);
    problems.push(...verifyRecord(root, record, runner, out));
  }

  if (problems.length > 0) {
    out("mutation check FAILED:");
    for (const p of problems) out(` - ${p}`);
    return 1;
  }
  const verified = toVerify.reduce((n, r) => n + r.mutations.length, 0);
  out(`mutation check ok: ${records.length} record(s) loaded, ${verified} mutation(s) verified red`);
  return 0;
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  process.exitCode = main(process.argv.slice(2), root, (line) => {
    console.log(line);
  });
}
