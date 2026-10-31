import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLOOR_CATEGORIES, openFindingsForPr, parseKnownFindings, validateKnownFindings } from "../../scripts/lib/known-findings.ts";

/**
 * docs/KNOWN_FINDINGS.md is the ledger a PR may merge against after its review-round budget (D-59). This gate
 * keeps it honest: every row parses, no open P1 sits in a severity-floor category, every open row names a
 * target rung, and every resolved or accepted row says by whom.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const LEDGER = `${ROOT}/docs/KNOWN_FINDINGS.md`;

const HEADER = "| PR | SHA | Reviewer | Finding | Severity | Category | Target rung | Status | Resolution |\n|---|---|---|---|---|---|---|---|---|\n";
const row = (cells: string[]): string => `| ${cells.join(" | ")} |\n`;

describe("docs/KNOWN_FINDINGS.md", () => {
  const text = readFileSync(LEDGER, "utf8");
  const parsed = parseKnownFindings(text);

  it("parses without errors", () => {
    expect(parsed.errors).toEqual([]);
  });

  it("holds no forbidden row", () => {
    expect(validateKnownFindings(parsed.rows)).toEqual([]);
  });

  it("states the severity floor categories exactly as the parser defines them", () => {
    for (const c of FLOOR_CATEGORIES) expect(text).toContain(`\`${c}\``);
  });
});

describe("known-findings rules on planted rows", () => {
  it("an open P1 in a floor category is a violation (it blocks merge instead)", () => {
    const text = HEADER + row(["#118", "0123abc", "codex", "notional cap compares with gte", "P1", "money-arithmetic", "next-pr", "open", ""]);
    const p = parseKnownFindings(text);
    expect(p.errors).toEqual([]);
    expect(validateKnownFindings(p.rows)).toEqual([expect.stringContaining("blocks merge")]);
  });

  it("an open P1 outside the floor is allowed when it names a target rung", () => {
    const text = HEADER + row(["#118", "0123abc", "codex", "status page omits halt state", "P1", "ergonomics", "rung-3", "open", ""]);
    expect(validateKnownFindings(parseKnownFindings(text).rows)).toEqual([]);
  });

  it("an open row without a target rung is a violation", () => {
    const text = HEADER + row(["#118", "0123abc", "codex", "slow fixture", "P2", "tests", "later", "open", ""]);
    expect(validateKnownFindings(parseKnownFindings(text).rows)).toEqual([expect.stringContaining("target rung")]);
  });

  it("a resolved row must name the fixing PR or commit", () => {
    const bad = HEADER + row(["#118", "0123abc", "codex", "slow fixture", "P2", "tests", "next-pr", "resolved", "fixed"]);
    const good = HEADER + row(["#118", "0123abc", "codex", "slow fixture", "P2", "tests", "next-pr", "resolved", "fixed in #119"]);
    expect(validateKnownFindings(parseKnownFindings(bad).rows)).toEqual([expect.stringContaining("fixing PR")]);
    expect(validateKnownFindings(parseKnownFindings(good).rows)).toEqual([]);
  });

  it("an accepted row needs the owner and a date, and can never be a floor P1", () => {
    const bad = HEADER + row(["#118", "0123abc", "codex", "doc wording", "P3", "docs", "rung-5", "accepted", "fine"]);
    const good = HEADER + row(["#118", "0123abc", "codex", "doc wording", "P3", "docs", "rung-5", "accepted", "owner accepted 2026-11-08"]);
    const floor = HEADER + row(["#118", "0123abc", "codex", "stale read", "P1", "temporal-reads", "rung-5", "accepted", "owner accepted 2026-11-08"]);
    expect(validateKnownFindings(parseKnownFindings(bad).rows)).toEqual([expect.stringContaining("owner")]);
    expect(validateKnownFindings(parseKnownFindings(good).rows)).toEqual([]);
    expect(validateKnownFindings(parseKnownFindings(floor).rows)).toEqual([expect.stringContaining("cannot be accepted")]);
  });

  it("malformed cells are parse errors, never silently skipped rows", () => {
    const text = HEADER + row(["118", "zz", "", "", "P9", "nope", "", "maybe", ""]);
    const p = parseKnownFindings(text);
    expect(p.errors.length).toBeGreaterThanOrEqual(6);
    expect(p.errors.some((e) => e.includes("PR must look like"))).toBe(true);
    expect(p.errors.some((e) => e.includes("SHA must be"))).toBe(true);
    expect(p.errors.some((e) => e.includes("severity"))).toBe(true);
    expect(p.errors.some((e) => e.includes("category"))).toBe(true);
    expect(p.errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("a document with no ledger table, or with two, is malformed rather than an empty ledger", () => {
    const none = parseKnownFindings("# Known findings\n\n| Column | Meaning |\n|---|---|\n| x | y |\n");
    expect(none.rows).toEqual([]);
    expect(none.errors).toEqual([expect.stringContaining("no ledger table found")]);
    const two = parseKnownFindings(HEADER + "\n" + HEADER);
    expect(two.errors).toEqual([expect.stringContaining("2 ledger tables")]);
  });

  it("tables with other headers are ignored, and open rows are found per PR", () => {
    const other = "| Column | Meaning |\n|---|---|\n| x | y |\n\n";
    const text = other + HEADER + row(["#118", "0123abc", "codex", "a", "P2", "tests", "next-pr", "open", ""]) + row(["#119", "0123abd", "codex", "b", "P2", "tests", "next-pr", "resolved", "#120"]);
    const p = parseKnownFindings(text);
    expect(p.errors).toEqual([]);
    expect(p.rows).toHaveLength(2);
    expect(openFindingsForPr(p.rows, 118).map((r) => r.finding)).toEqual(["a"]);
    expect(openFindingsForPr(p.rows, 119)).toEqual([]);
  });
});
