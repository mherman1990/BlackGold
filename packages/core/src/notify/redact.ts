/**
 * Notifications must not carry household dollar totals or secrets. Rather than silently scrubbing, this
 * REJECTS text that looks like a formatted currency amount (e.g. "$12,345"), an API key ("sk-..."), or a
 * token reference, so the defect is found at the call site.
 */

export class RedactionError extends Error {
  constructor(reason: string) {
    super(`Notification text rejected: ${reason}`);
    this.name = "RedactionError";
  }
}

const CURRENCY_TOTAL_RE = /\$\s?\d{1,3}(,\d{3})+/;
const SECRET_PATTERNS: readonly { re: RegExp; reason: string }[] = [
  { re: CURRENCY_TOTAL_RE, reason: "contains a currency amount" },
  { re: /sk-/, reason: 'contains "sk-" (API key prefix)' },
  { re: /token/i, reason: 'contains "token"' },
  { re: /bearer\s+[a-z0-9._-]+/i, reason: "contains a bearer credential" },
];

/** Returns the text unchanged when clean; throws RedactionError otherwise. */
export function redact(text: string): string {
  for (const { re, reason } of SECRET_PATTERNS) {
    if (re.test(text)) throw new RedactionError(reason);
  }
  return text;
}
