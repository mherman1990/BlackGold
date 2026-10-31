#!/usr/bin/env node
/**
 * Slow-test gate. Reads the vitest JSON report that `npm run test` writes (`.vitest/report.json`, see
 * vitest.config.ts) and fails if any single test ran longer than the threshold.
 *
 * HANDOFF.md section 7 has carried this rule as prose since 2026-09-21 ("if a new test lands above 5 s, treat
 * it as the next session's problem"); the 30 s testTimeout is a hang guard, not a budget, and runner speed
 * varies two to three times, so a 7 s test on a fast machine was a timeout on a slow one. This makes the
 * budget executable. Run after `npm run test`; CI does.
 *
 * Two thresholds. The SOFT one (5 s) is the target HANDOFF names; a test over it is printed as a warning so
 * the drift is visible every run. The HARD one (10 s) fails the check: it is three times under the 30 s
 * timeout, so a test that passes it cannot time out on a runner three times slower, while the suite's
 * slowest legitimate tests (4 to 6 s under load on 2026-10-31) do not make the gate itself flaky. A gate
 * that fails on runner speed trains people to ignore it.
 *
 *   node scripts/check-slow-tests.ts [--report .vitest/report.json] [--threshold-ms 10000] [--soft-ms 5000] [--top 10]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_THRESHOLD_MS = 10_000;
export const DEFAULT_SOFT_MS = 5_000;
export const DEFAULT_REPORT = ".vitest/report.json";

export type AssertionResult = { fullName?: string; title?: string; status?: string; duration?: number | null };
export type FileResult = { name?: string; assertionResults?: AssertionResult[] };
export type VitestJsonReport = { numTotalTests?: number; testResults?: FileResult[] };

export type TimedTest = { file: string; name: string; durationMs: number };
export type SlowAnalysis = { total: number; slow: TimedTest[]; warn: TimedTest[]; top: TimedTest[] };

/** Pure: lists every timed test, those over the hard threshold, those over the soft one, and the slowest `top`. */
export function analyzeReport(report: VitestJsonReport, thresholdMs: number, top = 10, softMs = DEFAULT_SOFT_MS): SlowAnalysis {
  const timed: TimedTest[] = [];
  for (const file of report.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      if (typeof a.duration !== "number") continue;
      timed.push({ file: file.name ?? "<unknown file>", name: a.fullName ?? a.title ?? "<unnamed>", durationMs: a.duration });
    }
  }
  timed.sort((x, y) => y.durationMs - x.durationMs);
  return {
    total: timed.length,
    slow: timed.filter((t) => t.durationMs > thresholdMs),
    warn: timed.filter((t) => t.durationMs > softMs && t.durationMs <= thresholdMs),
    top: timed.slice(0, top),
  };
}

function parseArgs(argv: readonly string[]): { report: string; thresholdMs: number; softMs: number; top: number } {
  let report = DEFAULT_REPORT;
  let thresholdMs = DEFAULT_THRESHOLD_MS;
  let softMs = DEFAULT_SOFT_MS;
  let top = 10;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a ?? ""} needs a value`);
      return v;
    };
    if (a === "--report") report = next();
    else if (a === "--threshold-ms") thresholdMs = Number(next());
    else if (a === "--soft-ms") softMs = Number(next());
    else if (a === "--top") top = Number(next());
    else throw new Error(`unknown argument ${a ?? ""}`);
  }
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) throw new Error("--threshold-ms must be a positive number");
  if (!Number.isFinite(softMs) || softMs <= 0 || softMs > thresholdMs) throw new Error("--soft-ms must be a positive number no greater than --threshold-ms");
  return { report, thresholdMs, softMs, top };
}

export function main(argv: readonly string[], root: string, out: (line: string) => void): number {
  const { report, thresholdMs, softMs, top } = parseArgs(argv);
  const path = report.startsWith("/") ? report : join(root, report);
  if (!existsSync(path)) {
    out(`slow-test check FAILED: no report at ${path}; run \`npm run test\` first (vitest.config.ts writes the JSON report)`);
    return 1;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as VitestJsonReport;
  const analysis = analyzeReport(parsed, thresholdMs, top, softMs);
  if (analysis.total === 0) {
    out("slow-test check FAILED: the report holds no timed tests");
    return 1;
  }
  out(`slowest ${analysis.top.length} of ${analysis.total} tests (hard limit ${thresholdMs} ms, soft target ${softMs} ms):`);
  for (const t of analysis.top) out(`  ${t.durationMs.toFixed(0).padStart(6)} ms  ${t.name}  [${t.file}]`);
  for (const t of analysis.warn) out(`warn: ${t.durationMs.toFixed(0)} ms over the ${softMs} ms soft target: ${t.name} [${t.file}]`);
  if (analysis.slow.length > 0) {
    out(`slow-test check FAILED: ${analysis.slow.length} test(s) over ${thresholdMs} ms. Share the fixture, size the window to what the case reads, or seed in one transaction (HANDOFF.md section 7); do not raise the threshold.`);
    return 1;
  }
  out(`slow-test check ok: ${analysis.total} tests, none over ${thresholdMs} ms${analysis.warn.length > 0 ? `, ${analysis.warn.length} over the ${softMs} ms soft target` : ""}`);
  return 0;
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  process.exitCode = main(process.argv.slice(2), root, (line) => {
    console.log(line);
  });
}
