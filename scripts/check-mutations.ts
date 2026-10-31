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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/** Files whose guards protect money, time, accounts, order lifecycle or fail-closed behaviour. */
export const MANDATORY_PATTERNS: readonly RegExp[] = [
  /^packages\/core\/src\/risk\/.+\.ts$/,
  /^packages\/core\/src\/decision\/.+\.ts$/,
  /^packages\/core\/src\/execution\/.+\.ts$/,
  /^packages\/core\/src\/live\/.+\.ts$/,
  /^packages\/core\/src\/ledger\/.+\.ts$/,
  /^packages\/core\/src\/research\/(nav|stats|aggregate|simulator)\.ts$/,
  /^packages\/core\/src\/strategy\/construct\.ts$/,
  /^packages\/core\/src\/data\/adapters\/corporate-actions[^/]*\.ts$/,
  /^packages\/core\/src\/config\/load\.ts$/,
  /^packages\/broker-gateway\/src\/.+\.ts$/,
];

export type Mutation = { name: string; find: string; replace: string; test: string; testName?: string };
export type MutationRecord = { file: string; mutations: Mutation[]; source: string };

export function isMandatory(file: string): boolean {
  if (/\.test\.ts$/.test(file)) return false;
  return MANDATORY_PATTERNS.some((re) => re.test(file));
}

export function mandatoryChangedFiles(changed: readonly string[]): string[] {
  return changed.filter(isMandatory);
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

export type Runner = (test: string, testName: string | undefined) => number;

/**
 * Applies each mutation of `record` to the file on disk, runs the named test through `runner`, and expects a
 * non-zero exit. Restores the original bytes in `finally`. Returns one problem string per surviving mutation
 * or per malformed mutation.
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
    const baseline = runner(m.test, m.testName);
    if (baseline !== 0) {
      problems.push(`${record.source} [${m.name}]: ${m.test}${m.testName ? ` -t "${m.testName}"` : ""} is not green on the unmodified source (exit ${baseline}); the filter matches no test, or the test is already red`);
      continue;
    }
    try {
      writeFileSync(path, mutated);
      const code = runner(m.test, m.testName);
      if (code === 0) {
        problems.push(`${record.source} [${m.name}]: SURVIVED - ${m.test}${m.testName ? ` -t "${m.testName}"` : ""} stayed green with the mutation applied; that test does not guard this invariant`);
      } else {
        log(`  killed: ${record.file} [${m.name}] -> ${m.test} went red (exit ${code})`);
      }
    } finally {
      writeFileSync(path, original);
    }
  }
  return problems;
}

export function vitestRunner(root: string, template?: string): Runner {
  return (test, testName) => {
    if (template !== undefined) {
      const cmd = template.replaceAll("{test}", test).replaceAll("{name}", testName ?? "");
      const r = spawnSync("sh", ["-c", cmd], { cwd: root, stdio: "ignore" });
      return r.status ?? 1;
    }
    // `--reporter` on the command line replaces the configured reporters, so these runs do not overwrite the
    // JSON report `check-slow-tests` reads from the full `npm run test`.
    const args = ["vitest", "run", "--reporter=dot", test];
    if (testName !== undefined) args.push("-t", testName);
    const r = spawnSync("npx", args, { cwd: root, stdio: "ignore" });
    return r.status ?? 1;
  };
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

export function main(argv: readonly string[], root: string, out: (line: string) => void, runnerOverride?: Runner): number {
  const args = parseArgs(argv);
  const records = loadRecords(join(root, args.records));
  const byFile = new Map(records.map((r) => [r.file, r] as const));
  const problems: string[] = [];

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
    const mandatory = mandatoryChangedFiles(changed);
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
