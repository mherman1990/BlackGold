# Handoff

How a fresh Claude Code session resumes Black Gold safely.

## 1. Orient

1. Run `git status`, `git branch --show-current`, `git remote -v`, `git worktree list`, `git log --oneline -5`. Confirm the remote is `mherman1990/BlackGold` and you are not on `main`.
2. Read `CLAUDE.md`, `STATE.md`, this file, `docs/DECISIONS.md`, and `PLAN.md`, in that order.
3. Run `/context` and confirm `CLAUDE.md` and `.claude/rules/*` are listed under memory files.
4. `npm ci && npm run check`. All of lint, typecheck, 122 tests, identity check, and secret scan must pass before you change anything.

## 2. Repository guard

If the checkout is anything other than `mherman1990/BlackGold`, stop. Do not create Black Gold files anywhere else.

## 3. Current position (2026-09-07)

- PR #1 (Discovery Pack) is open against `main`, awaiting Matt.
- Phase 0 implementation is complete on `claude/phase-00-foundation` (stacked on the Discovery branch, D-26) as PR #2.
- `main` exists but is not yet the default branch and has no protection. Matt does that in GitHub settings.
- No image has been published. No Umbrel install exists. No credential exists.

## 4. What Matt does next

1. GitHub → Settings → Branches: set `main` as default; add a ruleset for `main` requiring a PR, one approval, status checks (`checks`, `image` from `ci.yml`), no force pushes; restrict `v*` tags to the owner.
2. Review and merge PR #1. Then retarget the Phase 0 PR to `main` (GitHub offers this automatically) and review it. Watch its CI: the `image` job is the first multi-arch build of the Dockerfile.
3. Before or after merging Phase 0, run the two hardware checks in `docs/PHASE0_REQUIREMENTS_MATRIX.md`: pull or build the image on the Pi and on the Windows Docker host, run `health` for both roles, and run `scripts/pi-benchmark.sh` on the Pi. Record results in the matrix.
4. Answer the open facts: D-12 (sleeve account), D-16 (backup destination), D-04 port check on the Pi.
5. Authorize Phase 1 explicitly.

## 5. When Phase 1 is authorized

1. `git fetch origin main`; confirm both Discovery and Phase 0 are merged.
2. `git checkout -b claude/phase-01-research-kernel origin/main`.
3. Re-verify CR-01, CR-02, CR-04, CR-05, CR-09 in `docs/CAPABILITY_REGISTER.md` (SEC, FRED, CFTC, Alpaca data entitlement) before writing adapters. Resolve D-24 (market data source) with Matt if CR-09 changes the picture.
4. Build only the Phase 1 deliverables in `PLAN.md`: point-in-time repository with the `asOf` rule, artifact store, adapters, raw versus adjusted prices, corporate actions, universe snapshots, experiment registry, NAV accounting, fill/cost simulator, benchmarks, and the 16 temporal fixtures from `docs/DATA_PROVENANCE_SPEC.md`. `.claude/rules/temporal-data.md` applies.
5. Stage exact paths. `npm run check` before every commit. Push and open the PR only with Matt's authorization for those actions (this session had it; do not assume the next one does).
6. Update `STATE.md`, this file, and `docs/DECISIONS.md` before ending.

## 6. Things that must never happen in any session

- Pushing to `main`, force-pushing, or merging.
- Adding a live-trading code path, a broker credential, or a workplace data connector.
- Copying identifiers, paths, ports, or adapters from any other application.
- Running a release workflow, publishing an image, or installing on the Pi without explicit authorization for that specific action.
- Marking a safety requirement complete from inspection alone.

## 7. Known environment quirks

- npm 10 crashes on vitest's peer set; `.npmrc` sets `legacy-peer-deps=true`. Node 24's npm may not need it.
- Node 22 prints an ExperimentalWarning for `node:sqlite`; Node 24 (container) is the target.
- No Docker daemon in the Claude Code sandbox; the image builds only in CI.
- decimal.js `isPositive()` returns true for +0. Use `gt(0)` (or shared `isStrictlyPositive`).
- `Db.transaction` is savepoint-aware; nested transactions are fine.
