# Handoff

How a fresh Claude Code session resumes Black Gold safely.

## 1. Orient

1. Run `git status`, `git branch --show-current`, `git remote -v`, `git worktree list`, `git log --oneline -5`. Confirm the remote is `mherman1990/BlackGold` and you are not on `main`.
2. Read `CLAUDE.md`, `STATE.md`, this file, `docs/DECISIONS.md`, and `PLAN.md`, in that order.
3. Run `/context` and confirm `CLAUDE.md` and `.claude/rules/*` are listed under memory files.
4. `npm ci && npm run check`. All of lint, typecheck, 513 tests, identity check, and secret scan must pass before you change anything.

## 2. Repository guard

If the checkout is anything other than `mherman1990/BlackGold`, stop. Do not create Black Gold files anywhere else.

## 3. Current position (2026-09-07)

- Everything through Phase 2, plus release prep (PR #8) and the Phase 0 seal completion (PR #9), is merged to `main` at `03bf580`.
- Phase 2 machinery took two PRs to land: PR #5 merged into `claude/phase-01-research-kernel` twelve seconds after PR #4 had merged that branch forward, so it never reached `main`, and PR #6 carried the same tree there (D-36). When resuming, verify rather than assume: `git merge-base --is-ancestor <branch> origin/main`, and check `git diff origin/main <branch>` is empty.
- **No experiment is registered, no result has been computed, and the holdout has never been opened.** The charter is `DRAFT` and no market data has been ingested. Both are blockers, and either alone is sufficient.
- `main` exists but is not the default branch and has no protection. Matt does that in GitHub settings.
- No image has been published. No Umbrel install exists. No credential exists.
- **The release chain is blocked on one command, and not on judgement.** `release.yml` fires only on a pushed `v[0-9]+.[0-9]+.[0-9]+` tag, and this session's git credential cannot create tag refs or delete refs: `git push origin v0.1.0` and `git push origin --delete <branch>` both return HTTP 403 from GitHub, while ordinary branch pushes to the same repo succeed and the agent proxy reports healthy. D-37 grants the authority; the credential does not carry it. Do not burn a session retrying this - confirm it once and say so.
- **PR #9's integrity changes had no external review.** Codex was out of usage budget for its code review on every commit and for a re-requested security review; the only completed security pass ran on `d9d8054`, three commits behind what merged. The corruption path PR #9 fixes was found by Claude Code reviewing Claude Code. Treat `packages/core/src/ledger/ledger.ts` and the `seal_ledger` job as reviewed once, by an interested party.

## 4. What Matt does next

1. GitHub -> Settings -> Branches: set `main` as default; add a ruleset for `main` requiring a PR, one approval, status checks (`checks`, `image` from `ci.yml`), no force pushes.

   **Decide about `v*` tags rather than inheriting the current accident.** This item used to say "restrict `v*` tags to the owner", which directly contradicts D-37's grant of tag creation to Claude Code - and today the effect is already in force, not by a ruleset but because the session credential is refused tag refs at all. Two coherent options, and the tension should be resolved on purpose:
   - *Owner-only tags.* Keep the restriction, and amend D-37 to drop tag creation. Every release then waits on Matt by design. Defensible: publishing an image is the one step in the chain that is outward-facing.
   - *Claude Code may tag.* Grant tag-ref permission and keep D-37 as written. The release workflow's own guard already enforces what matters - the tag must match `package.json` and be reachable from `main` - so an accidental or premature tag cannot publish anything, and a bad tag is deletable.

   Either is fine; having D-37 say one thing and the credential enforce the other is not, because it makes autonomy look broken when it is only misconfigured.
2. **Push the `v0.1.0` tag**: `git fetch origin main && git tag v0.1.0 03bf580 && git push origin v0.1.0`. Or grant Claude Code tag-ref permission and it will do this and the rest of the chain. Nothing installable exists until this happens, and every remaining release step is downstream of it.
3. Delete `claude/phase-00-foundation`, `claude/black-gold-trading-tool-n713ly` and `claude/phase-01-research-kernel`. Verified safe: each carries zero non-merge commits absent from `main`, and their only commits beyond it are orphan merge commits from the D-36 incident. Leaving them around is what makes the mis-merge easy to repeat.
4. Run the two hardware checks in `docs/PHASE0_REQUIREMENTS_MATRIX.md`: pull or build the image on the Pi and on the Windows Docker host, run `health` for both roles, and run `scripts/pi-benchmark.sh` on the Pi. Record results in the matrix.
5. Answer the standing open facts: D-12 (sleeve account), D-16 (backup destination), D-04 port check on the Pi.
6. Provide the credentials the first live ingest needs: `BLACKGOLD_SEC_USER_AGENT_CONTACT` (an email), `BLACKGOLD_FRED_API_KEY`, `BLACKGOLD_ALPACA_KEY_ID` and `BLACKGOLD_ALPACA_SECRET_KEY` (paper keys work for data). They go into the Umbrel app environment or a local `.env`, never into git.
7. **Confirm or overrule D-32** (book-slot priority between the entry rule and the hysteresis hold rule). The prose charter is genuinely ambiguous; the code resolves it in favour of the incumbent and explains why. Whichever way it goes, section 8 of `ALPHA_CHARTER.md` should say so in one sentence before anything is frozen.
8. **Resolve the four open decisions inside `strategies/etf-trend-vol/charter.yaml`** (compliance look-through, live cash instrument, `risk.yaml` defaults, market-data source), decide XLE, and sign the approval block. `node packages/core/dist/main.js charter show --path strategies/etf-trend-vol/charter.yaml` lists exactly what is missing and refuses until all of it is filled in.

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

- Pushing or committing directly to `main`, force-pushing, or rewriting anyone else's history. Merging is authorized (D-37); bypassing the PR is not.
- Merging a stacked PR into a base branch that has already been merged forward. Retarget it to `main` first, or merge it before its base goes in. This has now cost two extra PRs (D-36); before merging anything stacked, check `git merge-base --is-ancestor <base-head> origin/main` and retarget if it answers yes.
- Registering an experiment on a charter that `assertRegistrable` refuses, or editing a frozen charter value in code instead of in `charter.yaml`.
- Opening the holdout, or evaluating anything inside its dates, without Matt's written decision and the registry call.
- Computing or displaying a result and then changing a parameter, grid, boundary, metric, or cost without a new experiment id and a parent.
- Adding a live-trading code path, a broker credential, or a workplace data connector.
- Copying identifiers, paths, ports, or adapters from any other application.
- Signing a charter approval block, resolving a charter's open decisions, admitting a conditional universe member, opening a holdout, citing a run as promotion evidence, or accepting Claude Code's own results as investment evidence. Standing git autonomy (D-37) never reaches these: propose them, never perform them.
- Installing on the Pi or running `scripts/pi-benchmark.sh`, which need Matt's hardware.
- Marking a safety requirement complete from inspection alone.

## 7. Known environment quirks

- npm 10 crashes on vitest's peer set; `.npmrc` sets `legacy-peer-deps=true`. Node 24's npm may not need it.
- Node 22 prints an ExperimentalWarning for `node:sqlite`; Node 24 (container) is the target.
- No Docker daemon in the Claude Code sandbox; the image builds only in CI.
- `/health` rehashes the entire ledger (`verifyChain`) and runs `PRAGMA integrity_check` over the whole database on every request, and the container healthcheck calls it every 60 s with a 20 s timeout. Fine at Phase 0 scale; once the ledger carries real decision and order traffic this becomes a restart loop, which is the same failure class as an unsealable day. Needs incremental verification (verify from the last seal forward, full check on a schedule) before any phase that writes at volume. Not a Phase 0 blocker; do not fix it inside an unrelated PR.
- decimal.js `isPositive()` returns true for +0. Use `gt(0)` (or shared `isStrictlyPositive`).
- `Db.transaction` is savepoint-aware; nested transactions are fine.
- A ledger event's `at` must be the instant it happened, never a timestamp captured earlier in the same function. The seal job closes days automatically, and an append dated inside a sealed day is refused (`SealedDateAppendError`) because accepting it would corrupt that day's root with no repair path. `runIngest` had this bug: one `ingestedAt` correctly stamped every observation in the run (so a multi-page fetch stays coherent) but was also used for the ledger events, hours later. The run's start belongs in the payload as `startedAt`.
- ESLint forbids a float literal as a direct child of `+ - * /`. Statistics code that genuinely needs floating point names its coefficients as constants (see `packages/core/src/research/stats.ts`).
- The feature engine and `RawSeries` take `ReadOnlyPointInTime`, not the repository. That is deliberate: a decision path cannot append an observation. Pass a `LeakageAuditor` where the reads should be audited.
- A full backtest over a few hundred sessions takes a second or two because the feature engine re-reads its window at every decision. That is the honest cost of reading point-in-time; do not cache across decision instants.
- `vitest.config.ts` sets `testTimeout: 30_000` for the whole suite. Vitest's 5-second default is not a realistic ceiling for a multi-decision backtest, and leaving it there let the same commit pass on one CI runner and time out on another. Raising it per file was tried first and did not hold: the next run timed out in a file that had never failed before. Do not lower it, and do not add a per-file override - if a test needs more than 30 s, the test is the problem.
- The heavy research suites share one read-only fixture market across their cases rather than rebuilding it per test. `runBacktest` never writes, so that cannot couple them, and it is what actually made the suite fast (44 s -> 24 s). Follow the pattern in any new suite that needs a synthetic market.
