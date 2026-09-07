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
- PR #2 (Phase 0) is open against the Discovery branch, CI green, review findings resolved.
- Discovery (PR #1) and Phase 0 (PR #2) are merged to `main`. PR #3 (Phase 1) merged into the Phase 0 branch after it had been merged forward, so `main` lacks Phase 1; PR #4 (draft) carries the identical reviewed tree to `main`. 264 tests, all 16 temporal fixtures. Next owner action: mark PR #4 ready and merge it.
- `main` exists but is not yet the default branch and has no protection. Matt does that in GitHub settings.
- No image has been published. No Umbrel install exists. No credential exists. No live data ingest has run.

## 4. What Matt does next

1. GitHub → Settings → Branches: set `main` as default; add a ruleset for `main` requiring a PR, one approval, status checks (`checks`, `image` from `ci.yml`), no force pushes; restrict `v*` tags to the owner.
2. Review and merge PR #1. Then retarget the Phase 0 PR to `main` (GitHub offers this automatically) and review it. Watch its CI: the `image` job is the first multi-arch build of the Dockerfile.
3. Before or after merging Phase 0, run the two hardware checks in `docs/PHASE0_REQUIREMENTS_MATRIX.md`: pull or build the image on the Pi and on the Windows Docker host, run `health` for both roles, and run `scripts/pi-benchmark.sh` on the Pi. Record results in the matrix.
4. Answer the open facts: D-12 (sleeve account), D-16 (backup destination), D-04 port check on the Pi.
5. Mark PR #4 ready and merge it; that puts Phase 1 on `main`. Delete the merged `claude/phase-00-foundation` and Discovery branches afterwards.
6. Provide, when ready, the credentials the first live ingest needs: `BLACKGOLD_SEC_USER_AGENT_CONTACT` (an email), `BLACKGOLD_FRED_API_KEY`, `BLACKGOLD_ALPACA_KEY_ID` and `BLACKGOLD_ALPACA_SECRET_KEY` (paper keys work for data). They go into the Umbrel app environment or a local `.env`, never into git.
7. Approve and freeze `strategies/etf-trend-vol/ALPHA_CHARTER.md` (fill the approval block; every PROPOSED number becomes frozen) and authorize Phase 2 explicitly.

## 5. When Phase 2 is authorized

1. `git fetch origin main`; confirm Discovery, Phase 0, and Phase 1 are merged.
2. `git checkout -b claude/phase-02-etf-trend-vol origin/main`.
3. Write `strategies/etf-trend-vol/charter.yaml` from the approved charter, hash it, and register the experiment through `ExperimentRegistry` before any result is computed. Snapshot the ingested price data first (`snapshot create`).
4. Build only the Phase 2 deliverables in `PLAN.md`: the candidate engine for the approved charter, leakage audit, coverage report, walk-forward results, unopened holdout protocol, robustness/cost/delay/parameter tests, benchmark attribution, and the written "reasons it may not work". Every read goes through `PointInTimeRepository.asOf`. `.claude/rules/temporal-data.md` applies.
5. Stage exact paths. `npm run check` before every commit. Push and open the PR only with Matt's authorization for those actions (this session had it; do not assume the next one does).
6. Update `STATE.md`, this file, and `docs/DECISIONS.md` before ending. Engineering completion of Phase 2 is not investment evidence; stop and let Matt accept, reject, or revise.

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
