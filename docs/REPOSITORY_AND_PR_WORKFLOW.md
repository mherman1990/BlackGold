# Repository and pull-request workflow

## Topology

One public repository, `mherman1990/BlackGold`, containing Black Gold source plus its one-app Umbrel Community App Store manifest at the repository root. The store is added to umbrelOS by this repository's GitHub URL.

A private-source/public-store split was considered and is not recommended: it adds release coordination, and the container image is public and inspectable regardless. If Matt later requires private source, the store manifest moves to a minimal public `mherman1990/blackgold-store` repository and the release workflow gains a cross-repo manifest bump step. Decide before the first Umbrel install (D-03).

## Current state (2026-09-06, evening)

`main` exists (created from the bootstrap commit e7fc3d9 with Matt's authorization). The Discovery Pack is PR #1 from `claude/black-gold-trading-tool-n713ly` into `main`. Phase 0 implementation is on `claude/phase-00-foundation`, stacked on the Discovery branch (D-26); its PR targets the Discovery branch and is retargeted to `main` when PR #1 merges. Matt still needs to set `main` as the default branch and apply branch protection in GitHub settings; no tool in the Claude Code session reaches that API.

## Bootstrapping `main` (done 2026-09-06)

Matt authorized Claude Code to create `main` from the Discovery branch's first commit, which contains only `README.md` and `.gitignore`. For the record, the equivalent manual sequence was:

```bash
# On Matt's machine, after fetching
git fetch origin claude/black-gold-trading-tool-n713ly
BOOT=$(git rev-list --max-parents=0 origin/claude/black-gold-trading-tool-n713ly)
git push origin "$BOOT":refs/heads/main
```

Then in GitHub settings: set `main` as default, enable branch protection (below), and open a PR from the Discovery branch into `main`. The PR diff is exactly the Discovery Pack.

Alternative: Matt authorizes Claude Code to push that bootstrap commit to `main` in a later session. That is an external action requiring explicit authorization.

## Branch protection for `main`

- Require a pull request before merging; no direct pushes.
- Require at least one approval from the owner (`mherman1990`).
- Require status checks: `ci / lint`, `ci / typecheck`, `ci / test`, `ci / policy-tests`, `ci / identity-check`, `ci / secret-scan`, `ci / build-amd64`, `ci / build-arm64` once Phase 0 defines them.
- Require branches to be up to date before merging.
- Block force pushes and deletions.
- Restrict who can push tags matching `v*` to the owner.
- Optional: `CODEOWNERS` with `* @mherman1990`.

## Phase branch rules

1. Fetch. Confirm `origin/main` is clean and current. Never overwrite, stash, reset, or rebase unrelated changes.
2. Check for detached `HEAD` or an existing worktree before creating one. If Claude Code's `--worktree` created a `worktree-<name>` branch, rename it to the approved `claude/phase-XX-short-name` before the first commit.
3. One bounded phase (or a smaller coherent slice) per PR. The next phase branches from the new `origin/main` after merge. No stacking of financial-critical phases without a written stacked-PR plan approved in `docs/DECISIONS.md`.
4. Stage exact paths. `git add -A` and `git add .` are prohibited.
5. Commit messages: imperative summary line under 72 characters, body explaining why, no model identifiers.

## Authority matrix

**Superseded by D-37 (2026-09-07) and D-59 (2026-10-31); kept for the record.** Under D-37 Claude Code has
standing authority for the whole git and GitHub mechanic, including merging its own PRs to `main`, and under
D-38 it releases by dispatching `release.yml`. The owner acts that no autonomy reaches are listed in `CLAUDE.md`
("What standing authorization never covers"). The current authority matrix:

| Action | Who may do it | Authorization needed |
|---|---|---|
| Local commits, push, open PR, mark ready, merge to `main`, retarget, delete merged branches | Claude Code | Standing (D-37); `npm run check` green and `scripts/check-review-state.ts` passing before merge (D-59) |
| Create `v*` tag and publish the GHCR image | `release.yml` dispatched with the bare version (D-38) | The bump PR merged to `main` |
| Install or update the Umbrel app, run hardware checks | Matt on the Pi | Release verified per `docs/UMBREL_STORE_AND_RELEASE.md` |
| Sign a charter, policy or corporate-actions file; register an experiment; open the holdout; cite a run; enable a mode; introduce a credential | Matt only | Never delegated |
| Branch protection, GitHub App installation, repository secrets, ref deletion | Matt in the GitHub UI | Separately authorized because it changes permissions |

The original matrix, as written on 2026-09-06:

| Action | Who may do it | Authorization needed |
|---|---|---|
| Local commits on a phase branch | Claude Code | Implementation authorization for that phase |
| Push phase branch | Claude Code | Explicit per-session push authorization (granted for this Discovery session by the task assignment) |
| Open or update a draft PR | Claude Code | Explicit authorization |
| Mark PR ready for review | Claude Code | Explicit authorization |
| Merge | Matt only | Green CI plus owner review |
| Create `v*` tag | Matt, or Claude Code with explicit release authorization | Merged PR plus release decision |
| Publish GHCR image | Release workflow on `v*` tag only | Release authorization |
| Install or update the Umbrel app | Matt on the Pi | Release verified per `docs/UMBREL_STORE_AND_RELEASE.md` |
| Install GitHub App, create workflows or repository secrets | Matt, or Claude Code with explicit setup authorization | Separately authorized because it changes permissions |

## Pull request template

Every PR body includes, in order:

1. **Scope**: phase, slice, linked plan section.
2. **Requirements coverage**: matrix of `implemented` / `tested` / `deferred` / `blocked` / `not applicable` with evidence.
3. **Financial and security risk**: what could move money or expose a secret; why it cannot here.
4. **Migrations**: schema, config, data; forward and backward.
5. **Rollback**: exact steps.
6. **Tests**: commands run, environment, fixture provenance, pass/fail output.
7. **Resource impact**: measured or estimated Pi RAM/CPU/disk/spend change.
8. **Deferred items**.
9. **Live-trading statement**: "Live trading remains disabled by construction" unless the PR is an explicitly approved live-stage PR.

The template goes in `.github/pull_request_template.md` in Phase 0.

## Review

- CI must be green, including the slow-test gate and the mutation records (D-59).
- At most three external review rounds per PR. After that only a P1 finding on the severity floor blocks; every
  other open finding is a row in `docs/KNOWN_FINDINGS.md` with a target rung. `scripts/check-review-state.ts`
  refuses a merge with unpushed commits, a head the reviewer has not commented on, a review reply citing a sha
  not on the PR, or a missing template section. The full protocol is `.claude/rules/review-and-tests.md`.
- Owner review is welcome on any PR and is required for none, under D-37. The owner's acts are the ones listed
  in `CLAUDE.md` as never delegated, and the ruleset on `main` enforces checks, not approvals (plan decision
  DN-15, pending the owner's GitHub settings).
- Agent review (an external reviewer bot, or a Claude Code review subagent labelled `self`) supplements tests; it
  never replaces them, and a self-review never counts as an external round.

## Release

Design in `docs/UMBREL_STORE_AND_RELEASE.md`. Summary: merge first, then a separate explicit release step creates the `v*` tag, CI publishes `linux/amd64` and `linux/arm64` under the same tag and a digest, the version-consistency check must pass, and Matt updates the Umbrel app only after the post-publication checklist passes.

## Rollback

- Code: revert PR on `main` via a new PR.
- Release: publish a new patch tag pointing at the prior good commit; never retag or delete a published tag.
- Umbrel: Matt pins the previous image tag in the store manifest via a new release; data under `${APP_DATA_DIR}` is preserved across versions and migrations must be reversible or documented as one-way with a backup step first.
