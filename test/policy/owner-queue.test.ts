import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadQueue, renderQueue, validateQueue, type Queue, type QueueItem } from "../../scripts/owner-queue.ts";

/**
 * D-60 as code: the owner queue is valid, current, and cannot apply a default on the owner's behalf.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

function queueWith(items: Partial<QueueItem>[]): Queue {
  return {
    version: 1,
    updated: "2026-11-01",
    sittings: [{ id: "s", title: "S", when: "now", items: items.map((i, n) => ({ id: `i${n}`, kind: "data", title: "t", status: "pending", steps: ["x"], ...i })) }],
  };
}

describe("docs/owner-queue.yaml and docs/OWNER_QUEUE.md", () => {
  const q = loadQueue(join(ROOT, "docs/owner-queue.yaml"));

  it("the tracked queue is valid", () => {
    expect(validateQueue(q)).toEqual([]);
  });

  it("the rendered file is byte-identical to the render of the source", () => {
    expect(readFileSync(join(ROOT, "docs/OWNER_QUEUE.md"), "utf8")).toBe(renderQueue(q));
  });

  it("every sign item is owner-only and no item is applied without who and when", () => {
    for (const s of q.sittings) {
      for (const it of s.items) {
        if (it.kind === "sign") expect(it.ownerOnly, it.id).toBe(true);
        if (it.status === "applied" || it.status === "done") {
          expect(it.decidedBy, it.id).toBeTruthy();
          expect(it.decidedAt, it.id).toBeTruthy();
        }
      }
    }
  });

  it("every decision carries a recommended default, a reply format and a cost", () => {
    const decisions = q.sittings.flatMap((s) => s.items.filter((i) => i.kind === "decision"));
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d.recommendedDefault, d.id).toBeTruthy();
      expect(d.replyFormat, d.id).toBeTruthy();
      expect(d.costIfWrong, d.id).toBeTruthy();
    }
  });

  /** `$25,000`, `$25000`, `$25k`, `$1.5M`, `USD 25000`, `25,000 USD`, `25000 dollars`: the sleeve size never enters a tracked file (T-22). */
  const DOLLAR_TOTAL = /(\$|\bUSD\s?)\s?\d[\d,]*(\.\d+)?\s?[kKmM]?\b|\b\d[\d,]*(\.\d+)?\s?(USD|dollars?)\b/;

  it("no paste block names a host node or an un-sudo'd docker, and none carries a dollar total", () => {
    const text = readFileSync(join(ROOT, "docs/OWNER_QUEUE.md"), "utf8");
    expect(text).not.toMatch(/^\s*node packages\//m);
    expect(text).not.toMatch(/^\s*docker /m);
    expect(text).not.toMatch(DOLLAR_TOTAL);
    for (const s of ["$25,000", "$25000", "$25k", "$1.5M", "USD 25000", "25,000 USD", "25000 dollars"]) expect(s, s).toMatch(DOLLAR_TOTAL);
    for (const s of ['"$BLACKGOLD_SIGNER"', "$HOME/bg", "25 percent", "divided by 5.00", "0.1.15", "1000:1000"]) expect(s, s).not.toMatch(DOLLAR_TOTAL);
  });
});

describe("owner-queue rules on planted items", () => {
  it("a decision without a default, reply format or cost is invalid", () => {
    const problems = validateQueue(queueWith([{ kind: "decision", question: "q?" }]));
    expect(problems.some((p) => p.includes("recommendedDefault"))).toBe(true);
    expect(problems.some((p) => p.includes("replyFormat"))).toBe(true);
    expect(problems.some((p) => p.includes("costIfWrong"))).toBe(true);
  });

  it("an applied decision needs decidedBy and decidedAt; silence never applies a default", () => {
    const base = { kind: "decision" as const, question: "q?", recommendedDefault: "d", replyFormat: "r", costIfWrong: "c" };
    expect(validateQueue(queueWith([{ ...base, status: "applied" }]))).toEqual([expect.stringContaining("silence never applies")]);
    expect(validateQueue(queueWith([{ ...base, status: "applied", decidedBy: "Matt", decidedAt: "2026-11-08" }]))).toEqual([]);
    expect(validateQueue(queueWith([{ status: "applied", decidedBy: "Matt", decidedAt: "2026-11-08" }]))).toEqual([expect.stringContaining("only a decision")]);
  });

  it("decidedBy may not be Claude Code, silence or a default, and decidedAt is a date", () => {
    const base = { kind: "decision" as const, question: "q?", recommendedDefault: "d", replyFormat: "r", costIfWrong: "c", status: "applied" as const };
    for (const who of ["Claude Code", "claude (default, owner silent)", "silence", "default applied", "auto"]) {
      expect(validateQueue(queueWith([{ ...base, decidedBy: who, decidedAt: "2026-11-08" }])), who).toEqual([expect.stringContaining("is not the owner")]);
    }
    expect(validateQueue(queueWith([{ ...base, decidedBy: "Matt", decidedAt: "soon" }]))).toEqual([expect.stringContaining("YYYY-MM-DD")]);
  });

  it("a paste block may not run a host node or an un-sudo'd docker, and must start with bg or sudo", () => {
    expect(validateQueue(queueWith([{ kind: "command", block: "node packages/core/dist/main.js health" }]))).toEqual([expect.stringContaining("host `node`")]);
    expect(validateQueue(queueWith([{ kind: "command", block: "docker exec x node packages/core/dist/main.js health" }]))).toEqual([expect.stringContaining("without sudo")]);
    expect(validateQueue(queueWith([{ kind: "command", block: "npm run check" }]))).toEqual([expect.stringContaining("must start with")]);
    expect(validateQueue(queueWith([{ kind: "command", block: "# comment\nbg health\nsudo docker exec -i c node packages/core/dist/main.js version" }]))).toEqual([]);
  });

  it("every command on a line is checked: a chained or substituted host node or bare docker is refused", () => {
    for (const block of ["cd ~/BlackGold/packages/core && node dist/main.js health", "sudo true; node packages/core/dist/main.js health", "echo $(docker ps)", "ls | docker exec -i c sh", "export X=1 && docker rm x"]) {
      const problems = validateQueue(queueWith([{ kind: "command", block }]));
      expect(problems.length, block).toBeGreaterThan(0);
      expect(problems.join("\n"), block).toMatch(/host `node`|without sudo/);
    }
    expect(validateQueue(queueWith([{ kind: "command", block: "bg health | sudo tee /tmp/h.json" }]))).toEqual([]);
  });

  it("a heredoc fed to a shell is commands, not content", () => {
    const shell = "sudo bash <<'EOF'\ncd /app && node packages/core/dist/main.js health\nEOF";
    expect(validateQueue(queueWith([{ kind: "command", block: shell }]))).toEqual([expect.stringContaining("host `node`")]);
    const sh = "sudo sh <<EOF\ndocker rm x\nEOF";
    expect(validateQueue(queueWith([{ kind: "command", block: sh }]))).toEqual([expect.stringContaining("without sudo")]);
  });

  it("an owner-only act may not sit in a command item", () => {
    for (const line of ["bg experiment register --charter x", "bg policy sign --dir /data/policy --file risk.yaml", "bg corporate-actions sign --file x", "bg shadow rearm --to NORMAL", "sudo tee ~/umbrel/app-data/blackgold-trading/gateway-secrets/gateway.env", "echo X | sudo tee -a ~/umbrel/app-data/blackgold-trading/secrets/secrets.env"]) {
      expect(validateQueue(queueWith([{ kind: "command", block: line }])), line).toEqual([expect.stringContaining("owner-only act")]);
      expect(validateQueue(queueWith([{ kind: "sign", ownerOnly: true, block: line }])), line).toEqual([]);
    }
  });

  it("a sign item must be owner-only; a blocked item names its blocker; ids are unique", () => {
    expect(validateQueue(queueWith([{ kind: "sign", block: "bg policy sign --dir /data/policy --file risk.yaml --signer x" }]))).toEqual([expect.stringContaining("ownerOnly")]);
    expect(validateQueue(queueWith([{ status: "blocked" }]))).toEqual([expect.stringContaining("blockedBy")]);
    expect(validateQueue(queueWith([{ id: "same" }, { id: "same" }]))).toEqual([expect.stringContaining("duplicate id")]);
  });

  it("a heredoc body inside a paste block is file content, not commands; an unterminated one is refused", () => {
    const block = "sudo tee /x/gateway.env >/dev/null <<'EOF'\nBLACKGOLD_GATEWAY_HMAC_KEY=<hex>\nEOF\nbg-gateway credential-check";
    expect(validateQueue(queueWith([{ kind: "command", block }]))).toEqual([]);
    const unterminated = "sudo tee /x/gateway.env >/dev/null <<'EOF'\nnode packages/core/dist/main.js health";
    expect(validateQueue(queueWith([{ kind: "command", block: unterminated }]))).toEqual([expect.stringContaining("unterminated heredoc")]);
    expect(validateQueue(queueWith([{ kind: "command", block: "KEY=value\nbg health" }]))).toEqual([expect.stringContaining("must start with")]);
  });

  it("renders deterministically with a badge per status, and reproduces a paste block byte for byte", () => {
    const block = "sudo tee /x/f >/dev/null <<'EOF'\nline one\n\n\nline four\nEOF";
    const q = queueWith([{ title: "Do a thing", steps: ["one", "two"] }, { kind: "command", status: "blocked", blockedBy: "PR X", block: "bg health" }, { kind: "command", block }]);
    const a = renderQueue(q);
    expect(a).toBe(renderQueue(q));
    expect(a).toContain("[PENDING] i0: Do a thing");
    expect(a).toContain("[BLOCKED] i1");
    expect(a).toContain("Blocked by: PR X");
    expect(a).toContain("```bash\nbg health\n```");
    expect(a).toContain("```bash\n" + block + "\n```");
    expect(a).not.toMatch(/\n{3,}(?![^`]*```\n\n)/);
  });
});
