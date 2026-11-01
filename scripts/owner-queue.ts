#!/usr/bin/env node
/**
 * The owner queue (D-60): `docs/owner-queue.yaml` is the source, `docs/OWNER_QUEUE.md` is what the owner reads
 * at a sitting. This script validates the source and renders the document; the policy test
 * `test/policy/owner-queue.test.ts` proves the rendered file is current and that every item obeys the rules.
 *
 *   node scripts/owner-queue.ts            # render docs/OWNER_QUEUE.md from docs/owner-queue.yaml
 *   node scripts/owner-queue.ts --check    # exit 1 if the rendered file is stale or the source invalid
 *
 * Item kinds:
 *   decision  a question for the owner with a recommended default, a reply format and the cost of deciding wrong;
 *             silence re-proposes the default, nothing is `applied` without decidedBy and decidedAt
 *   command   a copy-paste block for the Pi: every line is `bg ...`, `bg-gateway ...`, a script under ~/bg, or
 *             `sudo ...` - never a bare `node` or `docker` (HANDOFF.md section 3)
 *   sign      a command the owner alone runs (a signature, a registration, a re-arm, a credential placement)
 *   data      something the owner downloads or produces
 *   github    something done in the GitHub UI or from the owner's own machine
 *
 * The owner's decision lines are recorded in docs/DECISIONS.md by Claude Code; the queue only proposes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const KINDS = ["decision", "command", "sign", "data", "github"] as const;
export const STATUSES = ["pending", "blocked", "done", "applied"] as const;
/** What a Pi paste line may start with. `bg`/`bg-gateway` and the scripts come from the image's scripts/pi. */
export const COMMAND_LINE_PREFIXES = ["bg ", "bg-gateway ", "sudo ", "scp ", "export ", "cd ", "ls ", "cat ", "~/bg/", "./", "pi-update.sh", "d57-reconcile.sh", "eval-store.sh", "stale-branches.sh", "echo "] as const;

export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];

export type QueueItem = {
  id: string;
  kind: Kind;
  title: string;
  status: Status;
  ownerOnly?: boolean;
  blockedBy?: string;
  /** decision */
  question?: string;
  recommendedDefault?: string;
  replyFormat?: string;
  costIfWrong?: string;
  /** command, sign */
  block?: string;
  /** data, github */
  steps?: string[];
  notes?: string;
  decidedBy?: string;
  decidedAt?: string;
};

export type Sitting = { id: string; title: string; when: string; minutes?: number; items: QueueItem[] };
export type Queue = { version: number; updated: string; intro?: string; sittings: Sitting[] };

function str(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Every rule a queue must satisfy, as sentences naming the item. Pure. */
export function validateQueue(q: Queue): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  if (q.version !== 1) out.push(`version must be 1, got ${String(q.version)}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.updated)) out.push(`updated must be a YYYY-MM-DD date, got "${String(q.updated)}"`);
  if (!Array.isArray(q.sittings) || q.sittings.length === 0) return [...out, "sittings must be a non-empty list"];
  for (const s of q.sittings) {
    if (!str(s.id) || !str(s.title) || !str(s.when)) out.push(`sitting "${String(s.id)}" needs id, title and when`);
    if (!Array.isArray(s.items)) {
      out.push(`sitting "${s.id}" has no items list`);
      continue;
    }
    for (const it of s.items) {
      const where = `item "${String(it.id)}" in sitting "${s.id}"`;
      if (!str(it.id)) out.push(`${where}: id is required`);
      else if (ids.has(it.id)) out.push(`${where}: duplicate id`);
      else ids.add(it.id);
      if (!(KINDS as readonly string[]).includes(it.kind)) out.push(`${where}: kind must be one of ${KINDS.join(", ")}`);
      if (!str(it.title)) out.push(`${where}: title is required`);
      if (!(STATUSES as readonly string[]).includes(it.status)) out.push(`${where}: status must be one of ${STATUSES.join(", ")}`);
      if (it.status === "blocked" && !str(it.blockedBy)) out.push(`${where}: a blocked item names what blocks it (blockedBy)`);
      if ((it.status === "applied" || it.status === "done") && (!str(it.decidedBy) || !str(it.decidedAt))) {
        out.push(`${where}: "${it.status}" needs decidedBy and decidedAt; silence never applies a default`);
      }
      if (it.status === "applied" && it.kind !== "decision") out.push(`${where}: only a decision can be "applied"; other kinds are "done"`);
      if (it.kind === "decision") {
        for (const k of ["question", "recommendedDefault", "replyFormat", "costIfWrong"] as const) {
          if (!str(it[k])) out.push(`${where}: a decision needs ${k}`);
        }
      }
      if (it.kind === "command" || it.kind === "sign") {
        if (!str(it.block)) out.push(`${where}: a ${it.kind} item needs a block to paste`);
        else {
          let heredoc: string | undefined;
          for (const raw of it.block.split("\n")) {
            const line = raw.trim();
            if (heredoc !== undefined) {
              // inside `<<'EOF' ... EOF`: the body is file content, not a command
              if (line === heredoc) heredoc = undefined;
              continue;
            }
            if (line.length === 0 || line.startsWith("#")) continue;
            const here = /<<-?\s*'?([A-Z_]+)'?\s*$/.exec(line);
            if (here?.[1] !== undefined) heredoc = here[1];
            if (/^node\s/.test(line) || (/node packages\//.test(line) && !/docker exec/.test(line))) {
              out.push(`${where}: a paste line runs a host \`node\` ("${line}"); use bg or sudo docker exec`);
            } else if (/^docker\s/.test(line)) {
              out.push(`${where}: a paste line runs docker without sudo ("${line}")`);
            } else if (!COMMAND_LINE_PREFIXES.some((p) => line.startsWith(p))) {
              out.push(`${where}: a paste line must start with one of ${COMMAND_LINE_PREFIXES.join(" | ")} ("${line}")`);
            }
          }
          if (heredoc !== undefined) out.push(`${where}: unterminated heredoc (no closing ${heredoc} line); nothing after it was checked`);
        }
      }
      if (it.kind === "sign" && it.ownerOnly !== true) out.push(`${where}: a sign item is the owner's act and must be tagged ownerOnly: true`);
      if ((it.kind === "data" || it.kind === "github") && (!Array.isArray(it.steps) || it.steps.length === 0)) out.push(`${where}: a ${it.kind} item needs steps`);
    }
  }
  return out;
}

const STATUS_BADGE: Record<Status, string> = { pending: "PENDING", blocked: "BLOCKED", done: "DONE", applied: "APPLIED" };

/** Deterministic markdown. Pure. */
export function renderQueue(q: Queue): string {
  const lines: string[] = [];
  lines.push("# Owner queue", "", `Generated from \`docs/owner-queue.yaml\` by \`scripts/owner-queue.ts\` (D-60). Do not edit by hand; edit the YAML and re-run \`npm run owner-queue\`. Last updated ${q.updated}.`, "");
  if (q.intro !== undefined) lines.push(q.intro.trim(), "");
  lines.push("Legend: **PENDING** is yours this sitting; **BLOCKED** waits on the named PR or release and needs nothing from you yet; **DONE** / **APPLIED** are recorded with who and when. A decision you do not answer is re-proposed next week with the same default; a default is never applied by Claude Code.", "");
  for (const s of q.sittings) {
    lines.push(`## ${s.title}`, "", `**When:** ${s.when}${s.minutes !== undefined ? ` (about ${s.minutes} minutes)` : ""}`, "");
    const open = s.items.filter((i) => i.status === "pending").length;
    const blocked = s.items.filter((i) => i.status === "blocked").length;
    lines.push(`${open} pending, ${blocked} blocked, ${s.items.length - open - blocked} done.`, "");
    for (const it of s.items) {
      const tag = it.ownerOnly ? " (owner only)" : "";
      lines.push(`### [${STATUS_BADGE[it.status]}] ${it.id}: ${it.title}${tag}`, "");
      if (it.status === "blocked") lines.push(`Blocked by: ${it.blockedBy ?? ""}`, "");
      if (it.kind === "decision") {
        lines.push(`**Question.** ${it.question ?? ""}`, "", `**Recommended default.** ${it.recommendedDefault ?? ""}`, "", `**Reply format.** \`${it.replyFormat ?? ""}\``, "", `**Cost if wrong.** ${it.costIfWrong ?? ""}`, "");
      }
      if ((it.kind === "command" || it.kind === "sign") && it.block !== undefined) {
        lines.push("```bash", it.block.trimEnd(), "```", "");
      }
      if (it.steps !== undefined) {
        for (const [i, step] of it.steps.entries()) lines.push(`${i + 1}. ${step}`);
        lines.push("");
      }
      if (it.notes !== undefined) lines.push(it.notes.trim(), "");
      if (it.decidedBy !== undefined && it.decidedAt !== undefined) lines.push(`Recorded: ${it.decidedBy}, ${it.decidedAt}.`, "");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function loadQueue(path: string): Queue {
  return parse(readFileSync(path, "utf8")) as Queue;
}

export function main(argv: readonly string[], root: string, out: (line: string) => void): number {
  const check = argv.includes("--check");
  const source = join(root, "docs/owner-queue.yaml");
  const target = join(root, "docs/OWNER_QUEUE.md");
  const q = loadQueue(source);
  const problems = validateQueue(q);
  if (problems.length > 0) {
    out("owner queue INVALID:");
    for (const p of problems) out(` - ${p}`);
    return 1;
  }
  const rendered = renderQueue(q);
  if (check) {
    const current = readFileSync(target, "utf8");
    if (current !== rendered) {
      out("owner queue STALE: docs/OWNER_QUEUE.md differs from the render of docs/owner-queue.yaml; run `npm run owner-queue`");
      return 1;
    }
    out("owner queue ok: rendered file is current");
    return 0;
  }
  writeFileSync(target, rendered);
  out(`owner queue written: ${target}`);
  return 0;
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  process.exitCode = main(process.argv.slice(2), root, (line) => {
    console.log(line);
  });
}
