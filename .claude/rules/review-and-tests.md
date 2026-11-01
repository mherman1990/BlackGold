---
paths:
  - "packages/**"
  - "test/**"
  - "scripts/**"
  - "strategies/**"
---

# Review and test protocol (D-59)

The loop this protocol ends: eleven review rounds in one sitting (PRs #91, #101, #114), a fix answered in the
thread but never pushed (`02f381d`), and a merge while a round was still running (#94, #102). Prose rules did
not stop any of them, so the rules below are enforced by scripts and policy tests; this file explains them.

## Definition of done for a PR

- `npm run check` is green, which now includes the slow-test gate and the mutation records.
- The PR body carries every template section, including **Review rounds**, **Mutation check** and **Known open findings**.
- At most **three external review rounds** have run. A round is one pass by the external reviewer bot (or the
  owner) on a pushed head; a Claude Code review subagent is `self` and never counts.
- Every changed file in the mandatory set (`scripts/check-mutations.ts`, `MANDATORY_PATTERNS`) has a record
  under `test/mutations/` whose mutations CI verified red. Elsewhere a record is optional.
- No open P1 on the severity floor: `orders`, `accounts`, `money-arithmetic`, `temporal-reads`, `fail-open`,
  `live-surfaces`.
- `node scripts/check-review-state.ts --pr-json <file>` passes and its output is pasted into the PR body.

## After round three

Stop fixing. A finding blocks the merge only if it is P1 **and** on the severity floor. Every other open finding
becomes a row in `docs/KNOWN_FINDINGS.md` with a target rung (`next-pr`, `rung-2` ... `rung-5`), the PR body's
**Known open findings** section names it, and the PR merges. A finding outside the PR's declared scope is a
follow-up from the first round, never a same-PR fix. Claude Code may call the stop under this rule; the owner
may override either way in `docs/OWNER_QUEUE.md`.

Deciding that a finding does not matter (status `accepted`) is the owner's act; Claude Code only defers with a
target rung.

## Merge discipline

- Never merge while a round is running. The check refuses a head the reviewer has not commented on, and a head
  on which a review was requested after the reviewer's last comment. The one exception: a head whose only
  difference from the reviewed commit is `docs/KNOWN_FINDINGS.md`, the ledger commit made after the last round.
- After the third round's fixes are pushed, request one more review of the final head as verification. What it
  raises is ledgered, not fixed, unless it is a P1 on the severity floor.
- The head on disk is the head on the PR: zero unpushed commits, no modified tracked files.
- Merge commits, not squash: round history must stay readable from `git log`. Review-fix commit subjects end
  with `(review round N)`.
- One PR per session. If it is not mergeable in one session, split it; do not leave it open.
- When the external reviewer is rate-limited, a completed round counts and an incomplete one does not. A
  financial-critical PR (orders, gateway, execution, live, ledger, money arithmetic) waits for an external round;
  a non-financial PR may merge with `--no-external-review "<reason>"`, which the script prints and records.

## Tests

- No test above 10 s; aim for 5 s. `scripts/check-slow-tests.ts` fails CI over the 10 s hard limit and prints a
  warning for anything over the 5 s soft target (the suite's slowest legitimate tests run 4 to 6 s under load).
  Share the fixture market, share the derived run, size the window to what the case reads, seed in one
  transaction (HANDOFF.md section 7). Never raise either number or the 30 s timeout.
- Mutation-check any guard on a financial invariant by writing the record, not a sentence: `find`, `replace`,
  the test that goes red. The three fixture anti-patterns a surviving mutation usually reveals: fixtures uniform
  in the dimension the code branches on; an expected value reachable by more than one behaviour; a redundant
  second guard masking the first.
- The policy-test count only rises (`test/policy/POLICY_FLOOR`). Lowering it, changing `docs/DECLARED_RUNG`,
  or editing `test/policy/live-disabled.test.ts` needs a decision (`D-NN`) cited in the PR body.

## Compute discipline

Run the targeted vitest project while iterating (`npx vitest run --project unit <file>`); run the full
`npm run check` once before push and once before merge, not between every edit.
