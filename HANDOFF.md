# Handoff

How a fresh Claude Code session resumes Black Gold safely.

## 1. Orient

1. Run `git status`, `git branch --show-current`, `git remote -v`, `git worktree list`, `git log --oneline -5`. Confirm the remote is `mherman1990/BlackGold` and you are not on `main`.
2. Read `CLAUDE.md`, `STATE.md`, this file, `docs/DECISIONS.md`, and `PLAN.md`, in that order.
3. Run `/context` and confirm `CLAUDE.md` and `.claude/rules/*` are listed under memory files.
4. Check for `CLAUDE.local.md`. It is private operator context; never commit it.

## 2. Repository guard

If the checkout is anything other than `mherman1990/BlackGold`, stop. Do not create Black Gold files anywhere else.

## 3. Current position (2026-09-06)

- Discovery Pack complete on `claude/black-gold-trading-tool-n713ly`.
- `main` does not exist. Matt creates it from this branch's root commit (see `docs/REPOSITORY_AND_PR_WORKFLOW.md`, "Bootstrapping `main`").
- No application code, no CI, no manifests, no credentials, no Umbrel install.

## 4. Next authorized action

**None.** The next action belongs to Matt:

1. Review `docs/DISCOVERY_PACK.md` and answer the decision list; record answers in `docs/DECISIONS.md` (or tell Claude Code the answers and authorize it to record them).
2. Create `main` from the bootstrap commit, set it default, configure branch protection.
3. Open the Discovery PR from this branch into `main` (or authorize Claude Code to open it).
4. Merge when satisfied.
5. Authorize Phase 0 implementation explicitly.

## 5. When Phase 0 implementation is authorized

1. `git fetch origin main` and confirm it is clean and contains the merged Discovery Pack.
2. `git checkout -b claude/phase-00-foundation origin/main`. If Claude Code created a `worktree-*` branch, rename it to this name before the first commit.
3. Resolve UM-07 to UM-09, CR-14, CR-20, CR-21 in `docs/CAPABILITY_REGISTER.md` first; write no manifest until they are resolved.
4. Build only the Phase 0 deliverables in `PLAN.md`. Do not touch Phase 1 items.
5. Stage exact paths. Commit locally. Push and open a draft PR only when Matt authorizes those actions.
6. Before ending the session: update `STATE.md`, this file, and `docs/DECISIONS.md`; record test commands and outputs; list deferred items.

## 6. Things that must never happen in any session

- Pushing to `main`, force-pushing, or merging.
- Adding a live-trading code path, a broker credential, or a workplace data connector.
- Copying identifiers, paths, ports, or adapters from any other application.
- Running a release workflow, publishing an image, or installing on the Pi without explicit authorization for that specific action.
- Marking a safety requirement complete from inspection alone.

## 7. Verification commands

No toolchain exists yet. After Phase 0 lands, list the exact `npm run` commands for lint, typecheck, test, policy tests, identity check, and secret scan here and in `CLAUDE.md`.
