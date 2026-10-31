#!/usr/bin/env node
/**
 * Pre-merge review-state check (D-59). Run before merging any PR; paste its output into the PR body.
 *
 * It exists because three failure modes have each happened more than once in this repository and prose
 * rules did not stop them: a PR merged while an external review round was still running (#94, #102), a fix
 * commit answered in the review thread but never pushed (`02f381d`), and an eleven-round fix loop with no
 * written exit condition (#91, #101, #114). Each check below names the incident it would have caught.
 *
 * The evaluation is pure (`evaluateReviewState`) so the policy tests can drive it with fixtures; the git
 * and GitHub facts are gathered separately. GitHub facts come from one of:
 *
 *   --pr-json <path>   a JSON file in the shape printed by --print-shape (produce it from the GitHub MCP
 *                      tools in a cloud session, where the `gh` CLI is unavailable)
 *   --pr <number>      read through the `gh` CLI, when it is installed and authenticated
 *
 *   node scripts/check-review-state.ts --pr-json pr.json [--max-rounds 3] [--no-external-review "<reason>"]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMandatory } from "./check-mutations.ts";
import { openFindingsForPr, parseKnownFindings, validateKnownFindings } from "./lib/known-findings.ts";

export const MAX_EXTERNAL_ROUNDS = 3;
/**
 * GitHub reports a check run by the workflow job's `name`, not its id, so these are the `name:` values in
 * .github/workflows/ci.yml (ids `checks` and `image`). A rename there must be mirrored here, and
 * review-tooling.test.ts asserts the two files agree.
 */
export const REQUIRED_CHECKS = ["lint, typecheck, test, policy, identity, secrets", "multi-arch image build (no push)"] as const;

/** Every heading the PR template requires. A missing one is a missing record of what the merge did. */
export const REQUIRED_HEADINGS = [
  "## Scope",
  "## Requirements coverage",
  "## Financial and security risk",
  "## Migrations",
  "## Rollback",
  "## Tests",
  "## Review rounds",
  "## Mutation check",
  "## Known open findings",
  "## Resource impact",
  "## Deferred items",
  "## Live-trading statement",
] as const;

/** Changes that must cite a decision (`D-NN`) in the PR body: they move a gate, not a feature. */
export const DECISION_GATED_PATHS = ["test/policy/POLICY_FLOOR", "docs/DECLARED_RUNG", "test/policy/live-disabled.test.ts"] as const;

export type PrFacts = {
  number: number;
  headSha: string;
  baseRef: string;
  isDraft: boolean;
  body: string;
  /** Status checks on the head commit; `conclusion` is GitHub's word (success, failure, neutral, ...). */
  checks: { name: string; conclusion: string | null }[];
  /**
   * Review comments by the external reviewer bot, in any order. `commitSha` is the commit the bot reviewed
   * (GitHub's `commit_id` on a review or review comment); when present it is what proves the current head was
   * reviewed. A comment without it falls back to the timestamp comparison, which is weaker and is said so.
   */
  botReviewComments: { createdAt: string; body?: string; commitSha?: string }[];
  /** ISO instant the head commit was committed. */
  headCommittedAt: string;
};

export type GitFacts = {
  localHeadSha: string;
  /** Modified or deleted tracked files (untracked files do not count). */
  dirtyTrackedFiles: string[];
  /** undefined when the branch has no upstream. */
  unpushedCommits: number | undefined;
  /** Files changed against the base ref, committed or in the working tree. */
  changedFiles: string[];
  /** Whether `sha` is reachable from HEAD. */
  isAncestorOfHead: (sha: string) => boolean;
  /** Returns old and new POLICY_FLOOR values when that file changed. */
  policyFloor: { base: number | undefined; head: number | undefined };
};

export type ReviewStateInput = {
  pr: PrFacts;
  git: GitFacts;
  knownFindingsMarkdown: string;
  maxExternalRounds: number;
  /** Set when the reviewer bot is unavailable; the reason is printed and recorded, never silent. */
  noExternalReviewReason?: string;
};

export type RoundRow = { round: number; sha: string; reviewer: string; outcome: string };

/** Parses the `## Review rounds` table: `| round | head sha | reviewer | outcome |`. */
export function parseRoundTable(body: string): { rows: RoundRow[]; errors: string[] } {
  const rows: RoundRow[] = [];
  const errors: string[] = [];
  const section = sectionOf(body, "## Review rounds");
  if (section === undefined) return { rows, errors: ["the body has no `## Review rounds` section"] };
  const lines = section.split("\n").filter((l) => l.trim().startsWith("|"));
  for (const line of lines) {
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    if (cells[0] === "Round") continue;
    if (cells.every((c) => c.length === 0)) continue; // the template's empty row
    const round = Number(cells[0]);
    const sha = cells[1] ?? "";
    if (!Number.isInteger(round) || round < 1) {
      errors.push(`review rounds: "${cells[0] ?? ""}" is not a round number`);
      continue;
    }
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      errors.push(`review rounds: round ${round} names "${sha}", not a commit sha`);
      continue;
    }
    rows.push({ round, sha, reviewer: cells[2] ?? "", outcome: cells[3] ?? "" });
  }
  return { rows, errors };
}

/** The text between a `## heading` and the next `## ` heading (or the end). */
export function sectionOf(body: string, heading: string): string | undefined {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** Every check as a problem sentence, or none. Pure. */
export function evaluateReviewState(input: ReviewStateInput): string[] {
  const { pr, git } = input;
  const problems: string[] = [];

  // 1. The reviewed commit is the one on disk, and everything on disk is pushed (the `02f381d` incident).
  if (git.dirtyTrackedFiles.length > 0) problems.push(`working tree has modified tracked files: ${git.dirtyTrackedFiles.join(", ")}`);
  if (git.unpushedCommits === undefined) problems.push("the branch has no upstream; push it before merging");
  else if (git.unpushedCommits > 0) problems.push(`${git.unpushedCommits} local commit(s) are not pushed; a review reply that cites them names code the PR does not contain`);
  if (git.localHeadSha !== pr.headSha) problems.push(`local HEAD ${git.localHeadSha.slice(0, 12)} is not the PR head ${pr.headSha.slice(0, 12)}`);

  // 2. Target and state.
  if (pr.baseRef !== "main") problems.push(`PR targets ${pr.baseRef}, not main (D-36: retarget a stacked PR before merging it)`);
  if (pr.isDraft) problems.push("PR is still a draft");

  // 3. The body is the only durable record of what the merge did.
  for (const h of REQUIRED_HEADINGS) if (!pr.body.split("\n").some((l) => l.trim() === h)) problems.push(`PR body is missing the "${h}" section`);
  if (!/Live trading remains disabled by construction/.test(pr.body)) problems.push("PR body does not carry the live-trading statement");

  // 4. Review rounds: every cited sha is on the PR, and the round budget holds.
  const table = parseRoundTable(pr.body);
  problems.push(...table.errors);
  for (const r of table.rows) {
    if (!git.isAncestorOfHead(r.sha)) problems.push(`review round ${r.round} cites ${r.sha}, which is not reachable from the PR head (was the fix pushed?)`);
  }
  const external = table.rows.filter((r) => !/^(self|claude|claude code)$/i.test(r.reviewer));
  const externalRounds = new Set(external.map((r) => r.round)).size;

  const ledger = parseKnownFindings(input.knownFindingsMarkdown);
  problems.push(...ledger.errors.map((e) => `docs/KNOWN_FINDINGS.md ${e}`));
  problems.push(...validateKnownFindings(ledger.rows).map((v) => `docs/KNOWN_FINDINGS.md ${v}`));
  const openForPr = openFindingsForPr(ledger.rows, pr.number);
  if (externalRounds > input.maxExternalRounds) {
    const section = sectionOf(pr.body, "## Known open findings") ?? "";
    const declaresNone = /\bnone\b/i.test(section);
    if (openForPr.length === 0 && !declaresNone) {
      problems.push(`${externalRounds} external review rounds exceed the budget of ${input.maxExternalRounds} (D-59); every still-open finding must be a row in docs/KNOWN_FINDINGS.md for #${pr.number}, or the section must say "none"`);
    }
  }
  for (const f of openForPr) {
    if (!pr.body.includes(f.finding.slice(0, 40))) problems.push(`docs/KNOWN_FINDINGS.md line ${f.line} is open for #${pr.number} but the PR body's "Known open findings" section does not mention it`);
  }

  // 5. CI on exactly this head.
  for (const name of REQUIRED_CHECKS) {
    const c = pr.checks.find((x) => x.name === name);
    if (c === undefined) problems.push(`required check "${name}" has not reported on ${pr.headSha.slice(0, 12)}`);
    else if (c.conclusion !== "success") problems.push(`required check "${name}" is ${c.conclusion ?? "pending"} on ${pr.headSha.slice(0, 12)}`);
  }

  // 6. No external round in flight (#94 and #102 merged mid-round). The bot must have reviewed THIS head.
  //    A comment that names the commit it reviewed is the proof; a late-finishing review of the PREVIOUS head
  //    can postdate the current head commit, so a timestamp alone is not (Codex P1, round 1).
  const financialChanged = git.changedFiles.filter((f) => isMandatory(f));
  if (pr.botReviewComments.length === 0) {
    if (input.noExternalReviewReason === undefined) {
      problems.push("no external review comment exists on this PR; pass --no-external-review \"<reason>\" to record why it is merging without one (a financial-critical path may not)");
    } else if (financialChanged.length > 0) {
      problems.push(`--no-external-review is refused: this PR changes financial-critical files (${financialChanged.slice(0, 3).join(", ")}${financialChanged.length > 3 ? ", ..." : ""}) and must wait for an external round (D-59)`);
    }
  } else {
    const withSha = pr.botReviewComments.filter((c) => c.commitSha !== undefined);
    if (withSha.length > 0) {
      const reviewedHead = withSha.some((c) => c.commitSha === pr.headSha);
      if (!reviewedHead) {
        const latest = [...withSha].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        problems.push(`no external review names the head commit ${pr.headSha.slice(0, 12)}; the latest reviewed ${latest?.commitSha?.slice(0, 12) ?? "?"}. The round on this head has not completed, do not merge mid-round`);
      }
    } else {
      const newest = pr.botReviewComments.map((c) => Date.parse(c.createdAt)).reduce((a, b) => Math.max(a, b), 0);
      const head = Date.parse(pr.headCommittedAt);
      if (!Number.isFinite(newest) || !Number.isFinite(head)) problems.push("review comment or head commit timestamps are unreadable");
      else if (newest < head) problems.push(`the newest external review comment predates the head commit; the round on ${pr.headSha.slice(0, 12)} has not completed, do not merge mid-round`);
      else problems.push("external review comments carry no commitSha, so only their timestamps say the head was reviewed; supply commit_id from the GitHub review data (a late review of a previous head can postdate this commit)");
    }
  }

  // 7. Moving a gate needs a decision on record.
  const gated = git.changedFiles.filter((f) => (DECISION_GATED_PATHS as readonly string[]).includes(f));
  if (gated.length > 0 && !/\bD-\d+\b/.test(pr.body)) problems.push(`this PR changes ${gated.join(", ")} but the body cites no decision (D-NN)`);
  if (git.policyFloor.base !== undefined && git.policyFloor.head !== undefined && git.policyFloor.head < git.policyFloor.base) {
    problems.push(`test/policy/POLICY_FLOOR drops from ${git.policyFloor.base} to ${git.policyFloor.head}; the floor only rises`);
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// Fact gathering (impure)

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function tryGit(root: string, args: string[]): string | undefined {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

export function gatherGitFacts(root: string, base: string): GitFacts {
  const localHeadSha = git(root, ["rev-parse", "HEAD"]);
  const dirtyTrackedFiles = git(root, ["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3));
  const unpushedRaw = tryGit(root, ["rev-list", "--count", "@{upstream}..HEAD"]);
  const unpushedCommits = unpushedRaw === undefined ? undefined : Number(unpushedRaw);
  const mergeBase = tryGit(root, ["merge-base", base, "HEAD"]);
  const changedFiles =
    mergeBase === undefined
      ? []
      : [...new Set(`${git(root, ["diff", "--name-only", mergeBase, "HEAD"])}\n${git(root, ["diff", "--name-only", "HEAD"])}`.split("\n").filter(Boolean))];
  const floorAt = (ref: string): number | undefined => {
    const raw = tryGit(root, ["show", `${ref}:test/policy/POLICY_FLOOR`]);
    return raw === undefined ? undefined : Number(raw.trim());
  };
  const headFloorPath = join(root, "test/policy/POLICY_FLOOR");
  return {
    localHeadSha,
    dirtyTrackedFiles,
    unpushedCommits,
    changedFiles,
    isAncestorOfHead: (sha) => spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: root }).status === 0,
    policyFloor: {
      base: mergeBase === undefined ? undefined : floorAt(mergeBase),
      head: existsSync(headFloorPath) ? Number(readFileSync(headFloorPath, "utf8").trim()) : undefined,
    },
  };
}

export const PR_JSON_SHAPE: PrFacts = {
  number: 118,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  baseRef: "main",
  isDraft: false,
  body: "<the PR body, verbatim>",
  checks: REQUIRED_CHECKS.map((name) => ({ name, conclusion: "success" })),
  botReviewComments: [{ createdAt: "2026-11-02T15:04:05Z", body: "<review comment>", commitSha: "0123456789abcdef0123456789abcdef01234567" }],
  headCommittedAt: "2026-11-02T14:00:00Z",
};

function prFactsFromGh(root: string, number: number): PrFacts {
  const view = JSON.parse(
    execFileSync("gh", ["pr", "view", String(number), "--json", "number,headRefOid,baseRefName,isDraft,body,statusCheckRollup,commits"], { cwd: root, encoding: "utf8" }),
  ) as {
    number: number;
    headRefOid: string;
    baseRefName: string;
    isDraft: boolean;
    body: string;
    statusCheckRollup?: { name?: string; context?: string; conclusion?: string | null; state?: string }[];
    commits?: { oid: string; committedDate: string }[];
  };
  const comments = JSON.parse(execFileSync("gh", ["api", `repos/{owner}/{repo}/pulls/${number}/comments`, "--paginate"], { cwd: root, encoding: "utf8" })) as {
    created_at: string;
    body?: string;
    commit_id?: string;
    user?: { login?: string; type?: string };
  }[];
  const reviews = JSON.parse(execFileSync("gh", ["api", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--paginate"], { cwd: root, encoding: "utf8" })) as {
    submitted_at?: string;
    body?: string;
    commit_id?: string;
    user?: { login?: string; type?: string };
  }[];
  const isBot = (u: { login?: string; type?: string } | undefined): boolean => u?.type === "Bot" || /codex|\[bot\]/i.test(u?.login ?? "");
  const head = view.commits?.find((c) => c.oid === view.headRefOid);
  return {
    number: view.number,
    headSha: view.headRefOid,
    baseRef: view.baseRefName,
    isDraft: view.isDraft,
    body: view.body,
    checks: (view.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? "", conclusion: (c.conclusion ?? c.state ?? null)?.toLowerCase() ?? null })),
    botReviewComments: [
      ...comments.filter((c) => isBot(c.user)).map((c) => ({ createdAt: c.created_at, body: c.body, commitSha: c.commit_id })),
      ...reviews.filter((r) => isBot(r.user) && r.submitted_at !== undefined).map((r) => ({ createdAt: r.submitted_at ?? "", body: r.body, commitSha: r.commit_id })),
    ].map((c) => {
      const out: { createdAt: string; body?: string; commitSha?: string } = { createdAt: c.createdAt };
      if (c.body !== undefined) out.body = c.body;
      if (c.commitSha !== undefined) out.commitSha = c.commitSha;
      return out;
    }),
    headCommittedAt: head?.committedDate ?? "",
  };
}

type Args = { prJson?: string; pr?: number; maxRounds: number; base: string; noExternalReview?: string; printShape: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { maxRounds: MAX_EXTERNAL_ROUNDS, base: "origin/main", printShape: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a ?? ""} needs a value`);
      return v;
    };
    if (a === "--pr-json") args.prJson = next();
    else if (a === "--pr") args.pr = Number(next());
    else if (a === "--max-rounds") args.maxRounds = Number(next());
    else if (a === "--base") args.base = next();
    else if (a === "--no-external-review") args.noExternalReview = next();
    else if (a === "--print-shape") args.printShape = true;
    else throw new Error(`unknown argument ${a ?? ""}`);
  }
  return args;
}

export function main(argv: readonly string[], root: string, out: (line: string) => void): number {
  const args = parseArgs(argv);
  if (args.printShape) {
    out(JSON.stringify(PR_JSON_SHAPE, null, 2));
    return 0;
  }
  let pr: PrFacts;
  if (args.prJson !== undefined) pr = JSON.parse(readFileSync(args.prJson.startsWith("/") ? args.prJson : join(root, args.prJson), "utf8")) as PrFacts;
  else if (args.pr !== undefined) pr = prFactsFromGh(root, args.pr);
  else {
    out("review-state check FAILED: pass --pr-json <file> (see --print-shape) or --pr <number>");
    return 2;
  }
  const input: ReviewStateInput = {
    pr,
    git: gatherGitFacts(root, args.base),
    knownFindingsMarkdown: readFileSync(join(root, "docs/KNOWN_FINDINGS.md"), "utf8"),
    maxExternalRounds: args.maxRounds,
  };
  if (args.noExternalReview !== undefined) input.noExternalReviewReason = args.noExternalReview;
  const problems = evaluateReviewState(input);
  if (args.noExternalReview !== undefined) out(`note: merging without an external review round, reason recorded: ${args.noExternalReview}`);
  if (problems.length > 0) {
    out(`review-state check FAILED for #${pr.number} at ${pr.headSha.slice(0, 12)}:`);
    for (const p of problems) out(` - ${p}`);
    return 1;
  }
  out(`review-state check ok: #${pr.number} at ${pr.headSha.slice(0, 12)} may merge`);
  return 0;
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  process.exitCode = main(process.argv.slice(2), root, (line) => {
    console.log(line);
  });
}
