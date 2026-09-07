# Handoff

How a fresh Claude Code session resumes Black Gold safely.

## 1. Orient

1. Run `git status`, `git branch --show-current`, `git remote -v`, `git worktree list`, `git log --oneline -5`. Confirm the remote is `mherman1990/BlackGold` and you are not on `main`.
2. Read `CLAUDE.md`, `STATE.md`, this file, `docs/DECISIONS.md`, and `PLAN.md`, in that order.
3. Run `/context` and confirm `CLAUDE.md` and `.claude/rules/*` are listed under memory files.
4. `npm ci && npm run check`. All of lint, typecheck, 494 tests, identity check, and secret scan must pass before you change anything.

## 2. Repository guard

If the checkout is anything other than `mherman1990/BlackGold`, stop. Do not create Black Gold files anywhere else.

## 3. Current position (2026-09-07)

- Discovery and Phase 0 are merged to `main` at `bbc7077`.
- Phase 1 is complete on `claude/phase-01-research-kernel` as PR #4 (draft, CI green). `main` does not have it yet.
- Phase 2 machinery is complete on `claude/black-gold-continued-rxiesj`, stacked on the Phase 1 branch.
- **No experiment is registered, no result has been computed, and the holdout has never been opened.** The charter is `DRAFT` and no market data has been ingested. Both are blockers, and either alone is sufficient.
- `main` exists but is not the default branch and has no protection. Matt does that in GitHub settings.
- No image has been published. No Umbrel install exists. No credential exists.

## 4. What Matt does next

1. GitHub -> Settings -> Branches: set `main` as default; add a ruleset for `main` requiring a PR, one approval, status checks (`checks`, `image` from `ci.yml`), no force pushes; restrict `v*` tags to the owner.
2. Mark PR #4 ready and merge it; that puts Phase 1 on `main`. Then review the Phase 2 PR and retarget it to `main` (GitHub offers this automatically). Delete the merged Phase 0 and Discovery branches afterwards.
3. Run the two hardware checks in `docs/PHASE0_REQUIREMENTS_MATRIX.md`: pull or build the image on the Pi and on the Windows Docker host, run `health` for both roles, and run `scripts/pi-benchmark.sh` on the Pi. Record results in the matrix.
4. Answer the standing open facts: D-12 (sleeve account), D-16 (backup destination), D-04 port check on the Pi.
5. Provide the credentials the first live ingest needs: `BLACKGOLD_SEC_USER_AGENT_CONTACT` (an email), `BLACKGOLD_FRED_API_KEY`, `BLACKGOLD_ALPACA_KEY_ID` and `BLACKGOLD_ALPACA_SECRET_KEY` (paper keys work for data). They go into the Umbrel app environment or a local `.env`, never into git.
6. **Confirm or overrule D-32** (book-slot priority between the entry rule and the hysteresis hold rule). The prose charter is genuinely ambiguous; the code resolves it in favour of the incumbent and explains why. Whichever way it goes, section 8 of `ALPHA_CHARTER.md` should say so in one sentence before anything is frozen.
7. **Resolve the four open decisions inside `strategies/etf-trend-vol/charter.yaml`** (compliance look-through, live cash instrument, `risk.yaml` defaults, market-data source), decide XLE, and sign the approval block. `node packages/core/dist/main.js charter show --path strategies/etf-trend-vol/charter.yaml` lists exactly what is missing and refuses until all of it is filled in.

## 5. When the charter is approved and data is ingested

Do these in order. Steps 1 to 4 are reversible; step 5 is not.

1. `git fetch origin main`; confirm Discovery, Phase 0, Phase 1 and Phase 2 are merged.
2. Ingest the universe (`ingest` per source), then `snapshot create --dataset prices_daily --description ...`. Nothing downstream may read outside a snapshot id.
3. `research coverage --path strategies/etf-trend-vol/charter.yaml --from 2007-06-01 --to <today>`. Read it before computing anything. Thin coverage on any member is a reason to stop, not a footnote.
4. `charter show` must report `registrable: true`. If it does not, stop: the reasons it prints are the work.
5. **Register the experiment before any result is computed.** `ExperimentRegistry.register` with the charter hash, the code commit, the snapshot ids and the coverage report id. The registration freezes the definition; after it, viewing a result is logged once and any change to hypothesis, rules, grid, boundaries, metrics or costs is a new experiment with a parent.
6. Run the design segment and its walk-forward schedule (`splitPlan`), every cost, delay and missing-data tier (`enumerateTiers`), and all 72 grid members (`enumerateGrid`). Write **every** evaluated cell to the trial ledger before displaying any of them: the ledger is the multiple-testing denominator, and a cell evaluated off-ledger corrupts it.
7. Build the report (`buildResultReport`) and check the leakage audit is clean. Evaluate the falsifiers (`evaluateFalsifiers`).
8. **Stop there.** Do not open the holdout. It opens once, only after Matt has reviewed the design and walk-forward results and written down a reason, through `ExperimentRegistry.openHoldout`. `holdoutSplit` refuses without a stated open and a CI gate keeps the evaluation plan out of the holdout window.
9. A failing result is a legitimate and expected outcome. Record it with the same permanence as a pass; do not adjust a parameter in response. A changed parameter is a new charter version starting at DRAFT.

## 6. Things that must never happen in any session

- Pushing to `main`, force-pushing, or merging.
- Registering an experiment on a charter that `assertRegistrable` refuses, or editing a frozen charter value in code instead of in `charter.yaml`.
- Opening the holdout, or evaluating anything inside its dates, without Matt's written decision and the registry call.
- Computing or displaying a result and then changing a parameter, grid, boundary, metric, or cost without a new experiment id and a parent.
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
- ESLint forbids a float literal as a direct child of `+ - * /`. Statistics code that genuinely needs floating point names its coefficients as constants (see `packages/core/src/research/stats.ts`).
- The feature engine and `RawSeries` take `ReadOnlyPointInTime`, not the repository. That is deliberate: a decision path cannot append an observation. Pass a `LeakageAuditor` where the reads should be audited.
- A full backtest over a few hundred sessions takes a second or two because the feature engine re-reads its window at every decision. That is the honest cost of reading point-in-time; do not cache across decision instants.
