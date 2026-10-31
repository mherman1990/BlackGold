## Scope

Phase / slice and linked `PLAN.md` section:

## Requirements coverage

| Requirement | Status (implemented / tested / deferred / blocked / n/a) | Evidence |
|---|---|---|
| | | |

## Financial and security risk

What in this change could move money, touch an account, or expose a secret, and why it cannot:

## Migrations

Schema, config, or data migrations (forward and backward):

## Rollback

Exact steps:

## Tests

Commands run, environment, fixture provenance, pass/fail output:

## Review rounds

One row per external review round on a pushed head (D-59; budget: three). A Claude Code review subagent is `self` and does not count.

| Round | Head SHA | Reviewer | Outcome |
|---|---|---|---|
| | | | |

Output of `node scripts/check-review-state.ts --pr-json <file>` before merge:

## Mutation check

One row per guard on a financial invariant this PR adds or changes; the record lives under `test/mutations/` and CI verifies it red. Write "none" if no file in the mandatory set changed.

| Invariant | Record | Test that went red |
|---|---|---|
| | | |

## Known open findings

Findings this PR merges with, each a row in `docs/KNOWN_FINDINGS.md` with a target rung, or "none". No open P1 on the severity floor.

## Resource impact

Measured or estimated change in Pi RAM, CPU, disk, or inference spend:

## Deferred items

## Live-trading statement

Live trading remains disabled by construction. (Edit only if this is an explicitly approved live-stage PR.)
