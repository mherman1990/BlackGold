/**
 * Parser and rules for `docs/KNOWN_FINDINGS.md`, the ledger of review findings a PR merged without fixing.
 *
 * Shared by `test/policy/known-findings.test.ts` (the CI gate) and `scripts/check-review-state.ts` (the
 * pre-merge check), so the two cannot disagree about what a valid row is.
 *
 * The ledger exists because of D-59: a PR may merge after three external review rounds with findings still
 * open, but only if every open finding is written down with a severity, a category and a target rung, and
 * only if none of them is a P1 in a category on the severity floor. A finding on the floor is one whose
 * defect could move money, touch an account, misread time, fail open, or reach a live surface; those block
 * the merge however many rounds have run.
 */

export const FLOOR_CATEGORIES = ["orders", "accounts", "money-arithmetic", "temporal-reads", "fail-open", "live-surfaces"] as const;
export const OTHER_CATEGORIES = ["tests", "docs", "process", "data", "performance", "ergonomics", "other"] as const;
export const SEVERITIES = ["P1", "P2", "P3"] as const;
export const STATUSES = ["open", "resolved", "accepted"] as const;
export const TARGET_RUNGS = ["next-pr", "rung-2", "rung-3", "rung-4", "rung-5"] as const;

export type FloorCategory = (typeof FLOOR_CATEGORIES)[number];
export type Category = FloorCategory | (typeof OTHER_CATEGORIES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Status = (typeof STATUSES)[number];

export type KnownFinding = {
  /** Pull request the finding was raised on, as `#123`. */
  pr: string;
  /** Head commit the review round ran against (7 to 40 hex characters). */
  sha: string;
  /** Who raised it: `codex`, `owner`, `self` (a Claude Code review subagent), or a name. */
  reviewer: string;
  finding: string;
  severity: Severity;
  category: Category;
  /** Where it must be fixed by. Required while `open`. */
  targetRung: string;
  status: Status;
  /** `resolved`: the fixing PR or commit. `accepted`: who accepted it and when. */
  resolution: string;
  line: number;
};

export type ParseResult = { rows: KnownFinding[]; errors: string[] };

const COLUMNS = ["PR", "SHA", "Reviewer", "Finding", "Severity", "Category", "Target rung", "Status", "Resolution"] as const;

export function isFloorCategory(c: string): c is FloorCategory {
  return (FLOOR_CATEGORIES as readonly string[]).includes(c);
}

function splitRow(line: string): string[] {
  // A markdown table row: leading and trailing pipes are optional; cells are trimmed.
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/**
 * Reads every markdown table in the document whose header row is exactly the ledger's columns. Rows in
 * other tables (the legend, for instance) are ignored. Malformed rows are reported, never skipped silently.
 */
export function parseKnownFindings(markdown: string): ParseResult {
  const rows: KnownFinding[] = [];
  const errors: string[] = [];
  const lines = markdown.split("\n");
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("|")) {
      inTable = false;
      continue;
    }
    const cells = splitRow(line);
    if (!inTable) {
      if (cells.length === COLUMNS.length && cells.every((c, j) => c === COLUMNS[j])) {
        inTable = true;
        const sep = splitRow(lines[i + 1] ?? "");
        if (!isSeparator(sep)) errors.push(`line ${i + 2}: ledger header is not followed by a separator row`);
        i += 1;
      }
      continue;
    }
    if (isSeparator(cells)) continue;
    const lineNo = i + 1;
    if (cells.length !== COLUMNS.length) {
      errors.push(`line ${lineNo}: expected ${COLUMNS.length} cells, found ${cells.length}`);
      continue;
    }
    const [pr, sha, reviewer, finding, severity, category, targetRung, status, resolution] = cells as [string, string, string, string, string, string, string, string, string];
    if (!/^#\d+$/.test(pr)) errors.push(`line ${lineNo}: PR must look like #123, got "${pr}"`);
    if (!/^[0-9a-f]{7,40}$/.test(sha)) errors.push(`line ${lineNo}: SHA must be 7 to 40 hex characters, got "${sha}"`);
    if (reviewer.length === 0) errors.push(`line ${lineNo}: reviewer is empty`);
    if (finding.length === 0) errors.push(`line ${lineNo}: finding is empty`);
    if (!(SEVERITIES as readonly string[]).includes(severity)) errors.push(`line ${lineNo}: severity must be one of ${SEVERITIES.join(", ")}, got "${severity}"`);
    if (!(FLOOR_CATEGORIES as readonly string[]).includes(category) && !(OTHER_CATEGORIES as readonly string[]).includes(category)) {
      errors.push(`line ${lineNo}: category "${category}" is not one of ${[...FLOOR_CATEGORIES, ...OTHER_CATEGORIES].join(", ")}`);
    }
    if (!(STATUSES as readonly string[]).includes(status)) errors.push(`line ${lineNo}: status must be one of ${STATUSES.join(", ")}, got "${status}"`);
    rows.push({
      pr,
      sha,
      reviewer,
      finding,
      severity: severity as Severity,
      category: category as Category,
      targetRung,
      status: status as Status,
      resolution,
      line: lineNo,
    });
  }
  return { rows, errors };
}

/**
 * The rules a well-formed ledger must satisfy. Each violation is a sentence naming the line.
 *
 *  - An `open` P1 in a floor category is a merge blocker (D-59), so it may not sit in the ledger at all: it
 *    is fixed, or the PR does not merge.
 *  - An `open` row names a target rung from the fixed list, so "later" is never where it goes.
 *  - A `resolved` row names the fixing PR (`#N`) or commit.
 *  - An `accepted` row names the owner and a date: deciding a finding does not matter is the owner's act,
 *    not Claude Code's (CLAUDE.md, "What standing authorization never covers").
 */
export function validateKnownFindings(rows: readonly KnownFinding[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const where = `line ${r.line} (${r.pr})`;
    if (r.status === "open") {
      if (r.severity === "P1" && isFloorCategory(r.category)) {
        out.push(`${where}: an open P1 in the floor category "${r.category}" blocks merge and may not be deferred`);
      }
      if (!(TARGET_RUNGS as readonly string[]).includes(r.targetRung)) {
        out.push(`${where}: an open finding needs a target rung from ${TARGET_RUNGS.join(", ")}, got "${r.targetRung}"`);
      }
    } else if (r.status === "resolved") {
      if (!/(#\d+|\b[0-9a-f]{7,40}\b)/.test(r.resolution)) out.push(`${where}: a resolved finding must name the fixing PR or commit`);
    } else {
      if (!/owner/i.test(r.resolution) || !/\d{4}-\d{2}-\d{2}/.test(r.resolution)) {
        out.push(`${where}: an accepted finding must record the owner's acceptance and its date`);
      }
      if (r.severity === "P1" && isFloorCategory(r.category)) {
        out.push(`${where}: a P1 in the floor category "${r.category}" cannot be accepted; it is fixed`);
      }
    }
  }
  return out;
}

export function openFindingsForPr(rows: readonly KnownFinding[], prNumber: number): KnownFinding[] {
  return rows.filter((r) => r.status === "open" && r.pr === `#${prNumber}`);
}
