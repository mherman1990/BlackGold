# Register the experiment (rung 1; starts the prospective clock)

The owner's act. Claude Code builds the line and runs `--dry-run`; it never runs the registration, marks a result
viewed, or opens the holdout (`CLAUDE.md`, "What standing authorization never covers"; D-60 item 4).

Registration freezes the signed charter (by hash), the commit the running image was built from, the snapshot
ids and the coverage report into one immutable record (`docs/EXPERIMENT_PROTOCOL.md` section 2). From that
instant every weekly shadow decision counts toward the 26-week SHADOW to PAPER minimum and the 52-week minimum
before `LIVE_MANUAL` (`ALPHA_CHARTER.md` sections 14.2 and 17; OD-10). It is one-way: the row can never be
deleted or edited, only superseded by a child experiment.

## Before you start

1. **The compose must seal.** The clock starts only from the process that seals decisions: `BLACKGOLD_MODE`
   `SHADOW` with `BLACKGOLD_SHADOW_CHARTER` set, which release 0.1.15's compose ships. Under `RESEARCH` the line
   below is refused with "cannot start the 26/52-week clock". That refusal is the guard working: a registration
   from a non-sealing process would sit in the store and start nothing.
2. **The image must be CI-built.** `bg health` prints `buildCommit`; it must be a 40-hex sha. A local build has
   `null` and registration refuses. That commit is frozen as `code.commit`, and every later trial must carry the
   same commit, so the design and walk-forward run that produces the rung-1 result runs on the same image.
3. **Decide the clock questions first.** DN-1, DN-3, DN-8 and DN-16 in `docs/OWNER_QUEUE.md`: a policy change
   after registration is a change inside the prospective record (D-54 c, D-55).
4. **Know what store you are on.** The Pi's research store carries Tiingo's single-source corporate actions, so a
   registration there is honestly non-citable (`promotionEvidenceAllowed: false`, label
   `UNVERIFIED_SINGLE_SOURCE`). That is intended: it anchors the clock. The citable child is registered later
   on the evaluation store (D-57(b)) with `--no-shadow-clock`.

## The sitting (research store, the clock anchor)

```bash
bg snapshot create --dataset prices_daily --description "shadow clock start"
# copy the snapshotId from the output into the next two lines
bg experiment register --charter strategies/etf-trend-vol/charter.yaml --snapshot prices_daily=<id> --registered-by "$BLACKGOLD_SIGNER" --dry-run
bg experiment register --charter strategies/etf-trend-vol/charter.yaml --snapshot prices_daily=<id> --registered-by "$BLACKGOLD_SIGNER"
bg shadow status --charter strategies/etf-trend-vol/charter.yaml
```

Read the dry run before the real line. It prints the definition hash the registration will carry, the coverage
report (`uncovered` must be empty; it refuses otherwise), the labels, `promotionEvidenceAllowed`, and
`shadowClock.startsClock`, which must be `true`. It writes nothing. The real line prints the same with the
`EXP-<year>-NNNN` id; `shadow status` then shows `registeredExperiments: 1`, which means the next Friday's
decision will seal rather than skip.

`--registered-by` is your name, typed on the line; `$BLACKGOLD_SIGNER` is expanded by your shell from
`~/.profile`. The CLI reads no environment and ships no default, and refuses blanks, roles (`owner`), agents
(`Claude Code`), placeholders and unexpanded variables.

## What is refused, and why

| Refusal | Cause | Do |
|---|---|---|
| `cannot start the 26/52-week clock` | the process is `RESEARCH` or has no shadow charter | update to a sealing compose first; `--no-shadow-clock <reason>` only for a registration that is not the anchor |
| `would never start the clock` | `--charter` is not the file the shadow job seals for | pass the configured charter path (the image's `strategies/etf-trend-vol/charter.yaml`) |
| `BLACKGOLD_BUILD_COMMIT is not set` | a local build | use the CI image |
| `is not registrable` | the charter's approval block is unsigned or a decision is open | sign and resolve in `charter.yaml`; never in code |
| `has no bars in the snapshot` | a universe member has nothing ingested | ingest, snapshot again, retry |
| `--require-citable: ... promotion-blocking data` | the store carries single-source actions | expected on the research store; drop the flag there, use it on the evaluation store |
| `Unknown snapshot` / `taken for dataset` | a mistyped id or dataset | copy the `snapshotId` from `snapshot create` |
| `SQLITE_BUSY` | a scheduler tick held the write lock for more than 5 s | nothing was written; run the line again |

## After

- Weekly: `bg shadow status` shows the next decision and `registeredExperiments`; a `0` before Friday means the
  week will be lost to the clock.
- `bg experiment list` and `bg experiment show --id EXP-...` print what was frozen.
- `bg experiment mark-viewed --id EXP-... --viewed-by "$BLACKGOLD_SIGNER"` is the first look at a result; after
  it, any change is a new experiment with `--parent`.
- `bg experiment open-holdout --id EXP-... --reason "<the written decision>" --requested-by "$BLACKGOLD_SIGNER"`
  opens the holdout once, only after the results are marked viewed. Not before the rung-1 review.

## The evaluation store (the citable child, later)

`eval-store.sh` builds the store and prints the line (D-57(b)):

```bash
experiment register --charter strategies/etf-trend-vol/charter.yaml --snapshot prices_daily=<id> --registered-by "$BLACKGOLD_SIGNER" --require-citable --no-shadow-clock "clock anchored at the research-store registration" --labels clock_anchor:<research EXP id>:<its definitionHash>
```

`--require-citable` refuses any promotion-blocking data, so a store that still carries a single-source action
cannot register as citable. `--no-shadow-clock` labels the row `NO_SHADOW_CLOCK` and writes an
`experiment.no_shadow_clock` ledger event: the shadow job never counts it as a clock anchor, even if a sealing
process is ever pointed at that store. The two stores' definition hashes differ by construction (snapshot ids
and the coverage report id are frozen inside), so the child cites the anchor's hash in a label rather than
expecting equality.
