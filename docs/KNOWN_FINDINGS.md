# Known findings

The ledger of review findings a pull request merged without fixing. It exists because of D-59: a PR may merge
after three external review rounds with findings still open, but only if every one of them is written here
with a severity, a category and a target rung, and only if none is a P1 in a category on the severity floor.

`test/policy/known-findings.test.ts` parses this file on every run and fails on a malformed or forbidden row.
`scripts/check-review-state.ts` reads it before a merge. The shared parser is `scripts/lib/known-findings.ts`.

## Rules

- **Severity floor.** An open `P1` in `orders`, `accounts`, `money-arithmetic`, `temporal-reads`, `fail-open` or
  `live-surfaces` blocks the merge however many rounds have run. It is fixed, or the PR does not merge. It cannot
  be `accepted` either.
- **Target rung.** An `open` row names where it must be fixed by: `next-pr`, `rung-2`, `rung-3`, `rung-4` or `rung-5`.
  "Later" is not a target.
- **Resolution.** A `resolved` row names the fixing PR (`#N`) or commit. An `accepted` row records the owner's
  acceptance and its date; deciding that a finding does not matter is the owner's act, never Claude Code's
  (`CLAUDE.md`, "What standing authorization never covers").
- **Rows are never deleted.** A fixed finding is marked `resolved`; the history stays.
- **Other categories:** `tests`, `docs`, `process`, `data`, `performance`, `ergonomics`, `other`.

## Ledger

| PR | SHA | Reviewer | Finding | Severity | Category | Target rung | Status | Resolution |
|---|---|---|---|---|---|---|---|---|
| #118 | ec2254dbcf54ca368eddcbea1c4a9a59511d3174 | codex | Mutation mandatory set omits compliance/engine.ts, data/lag-rules.ts and other compliance and temporal guard modules | P1 | process | next-pr | resolved | fixed in #119 |
| #118 | ec2254dbcf54ca368eddcbea1c4a9a59511d3174 | codex | Deleting a mutation record YAML without changing its source is not detected by check-mutations | P1 | process | next-pr | resolved | fixed in #119 |
| #118 | ec2254dbcf54ca368eddcbea1c4a9a59511d3174 | codex | Review-request marker accepted from any commenter, not only the PR author | P2 | process | next-pr | resolved | fixed in #119 |
| #120 | a6fcdce6f24025a4f26bc9d296c86f262e984e05 | codex | Owner-queue paste validator does not parse shell control clauses: `sudo true; if docker ps; then echo x; fi` passes because the segments resolve to `if`/`then`/`fi`, so a bare docker inside a compound statement is not examined | P2 | process | next-pr | open | |
