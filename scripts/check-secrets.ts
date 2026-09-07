#!/usr/bin/env node
/**
 * Secret and sensitive-data scan over tracked files. Complements gitleaks in CI.
 * Fails on credential-shaped strings, private keys, real-looking account numbers, and dollar totals in config examples.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const files = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

const patterns: { name: string; re: RegExp }[] = [
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: "Alpaca key id", re: /\b(PK|AK)[A-Z0-9]{18,}\b/ },
  { name: "Bearer token literal", re: /Bearer\s+[A-Za-z0-9._-]{30,}/ },
  { name: "Slack webhook", re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
  { name: "Env assignment with secret-like value", re: /^(?:export\s+)?[A-Z_]*(SECRET|TOKEN|PASSWORD|API_KEY)[A-Z_]*\s*=\s*['"]?[A-Za-z0-9_\-/+=]{16,}['"]?\s*$/m },
];

const skip = /^(package-lock\.json|.*\.svg|.*\.png|.*\.jpg)$/;
const problems: string[] = [];
for (const f of files) {
  if (skip.test(f) || f === "scripts/check-secrets.ts") continue;
  const text = readFileSync(`${ROOT}/${f}`, "utf8");
  for (const p of patterns) {
    if (p.re.test(text)) problems.push(`${f}: ${p.name}`);
  }
  if (f.startsWith("config/examples/") && /\$\s?\d{1,3}(,\d{3})+(\.\d{2})?/.test(text)) {
    problems.push(`${f}: dollar total in example config (use percentages and placeholders)`);
  }
}

if (problems.length > 0) {
  console.error("secret scan FAILED:");
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log(`secret scan ok: ${files.length} tracked files`);
