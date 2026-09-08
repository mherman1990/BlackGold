# First ingestion — from four credentials to a first coverage report

**Phase 1 → Phase 2. Run this the afternoon the four Stage 1 credentials land.** It takes the repository from
"machinery delivered, no data" to "market data ingested and coverage measured". `docs/ACCESS_AND_CREDENTIALS.md`
frames the four credentials as the remaining blocker to a first result; that is necessary but not sufficient —
a *correct* result also needs the **corporate-action ledger** for the same symbols (see the next section), which
D-29 supplies as vendored observations until an issuer feed is verified. This runbook covers both, and also
performs the CR-09 historical-depth measurement that the capability register still lists as unmeasured.

Nothing here opens the sealed holdout, registers an experiment, or computes a result a DRAFT charter could
cite — those are separate, and the last two are owner-gated (`charter.yaml` is already `APPROVED`, so
registration is unblocked, but registering and then viewing a result is the deliberate stop point Phase 2 ends
at). This runbook stops at a coverage report.

## What this charter's first result actually needs

The `etf-trend-vol` charter runs price-only arms (`arms: [B0_PASSIVE, B1_DETERMINISTIC]`,
`runtime_llm_in_signal: false`). Two data inputs are required for a first result, and both are market data —
no macro, filings, or positioning:

1. **Raw daily bars** (`alpaca.iex.bars.1d`) for every symbol. These drive execution simulation directly.
2. **The corporate-action ledger** (`corporate_action.*` observations — `CASH_DIVIDEND`, `SPLIT`, `SPINOFF`, …)
   for every symbol. The charter's features (252-session momentum, 200-session trend SMA, 63-session volatility)
   and all performance/benchmark comparison run on the **adjusted total-return series**, which Black Gold
   recomputes from the raw bars *plus* this ledger — it never trusts a provider's adjusted column
   (`docs/DATA_PROVENANCE_SPEC.md` §4). Raw bars alone yield a price-return series with unhandled dividends and
   splits, which is materially wrong (U.S. equity ETFs distribute ~1.5–3%/yr), so bars-only is **not** a ready
   dataset.

The `alpaca-bars` adapter pulls `adjustment=raw` and emits only bars — it does **not** produce corporate
actions. No live issuer distribution feed is verified yet, so per **D-29** they are *vendored*: curated into a
file reconciled across at least two independent public sources and loaded with `ingest corporate-actions
--file <path>` (Step 2b below). `docs/PHASE2_REQUIREMENTS_MATRIX.md` tracks "corporate-action records for the
14 ETFs, reconciled across two sources" as a tier-2 (after-credentials) requirement, with the XLF/XLRE 2015
spin-off as the acceptance case; `config/examples/corporate-actions.example.json` shows the file format. The
ingest mechanism now exists; **curating and reconciling the actual dataset is the open prerequisite** — until
the ledger is loaded the dataset is not ready (Step 5), and raw bars alone are a price-return artifact.

FRED, CFTC COT, and SEC submissions are **not required for this charter's first result**. They feed the Phase 3
LLM evidence packets, not the Phase 2 deterministic computation. Ingest them when Phase 3 begins, not now.

The symbols are the 13 universe members plus the secondary benchmark:

- **Risk ETFs (12, XLE excluded per OD-1):** `VTI QQQ IWM VTV VUG XLK XLF XLV XLI XLP XLU XLY`
- **Cash ETF:** `BIL`
- **Benchmarks:** `VTI` (primary, already in the universe), `SPY` (secondary — not in the universe, so it must
  be pulled explicitly for benchmark attribution)

That is 14 symbols to ingest: the 13 universe members and `SPY`.

## Step 1 — put the four credentials in the environment

Never in a tracked file, fixture, prompt, or log (`docs/ACCESS_AND_CREDENTIALS.md`). On Umbrel these go in the
app environment; for a local run, an untracked `.env` sourced into the shell.

```bash
export BLACKGOLD_SEC_USER_AGENT_CONTACT="you@example.com"   # SEC fair-access UA; not used by the bars pull, but ingest requires it to build the egress client
export BLACKGOLD_ALPACA_KEY_ID="..."                        # paper-account keys are sufficient for market data
export BLACKGOLD_ALPACA_SECRET_KEY="..."
export BLACKGOLD_DATA_DIR="/data"                           # or a local scratch dir off the Pi
```

`BLACKGOLD_FRED_API_KEY` is not needed for this runbook (no FRED pull here). `ingest` refuses before any
network call if a credential a given source needs is absent, so a missing key fails fast rather than
half-ingesting. Confirm the store is initialised first:

```bash
node packages/core/dist/main.js migrate
node packages/core/dist/main.js health          # expect live_disabled: mode RESEARCH; liveCapable=false
```

## Step 2 — pull the daily bars

Request a continuous span. Raw daily-bar storage is data collection at the point-in-time layer; it is **not**
"opening the holdout". Point-in-time leakage is prevented at decision-read time by the
`availableAt + processingDelay <= decisionAt` filter (see `.claude/rules/temporal-data.md`), and the sealed
2019–2024 holdout is protected at the evaluation/registry layer, opened once and logged under the holdout
protocol — never as a side effect of ingesting prices.

Start the span at least ~13 months (≈273 sessions) before the intended first decision date, so the
252-lookback + 21-skip momentum feature and the 200-session SMA have their warmup. The charter's
`registered_history_start` is `2007-06-01`, so a warmup start of `2006-04-01` covers it; the end is the
charter's `recent.end` of `2026-09-06`.

Ingest in two batches to stay well inside the 200-requests/minute Basic limit (CR-09) and keep each artifact
set small. Rerunning is safe — artifacts and observations deduplicate.

```bash
# Batch 1 — 7 symbols
node packages/core/dist/main.js ingest alpaca-bars \
  --symbols VTI,QQQ,IWM,VTV,VUG,XLK,XLF \
  --start 2006-04-01 --end 2026-09-06

# Batch 2 — 7 symbols (remaining universe + SPY benchmark)
node packages/core/dist/main.js ingest alpaca-bars \
  --symbols XLV,XLI,XLP,XLU,XLY,BIL,SPY \
  --start 2006-04-01 --end 2026-09-06
```

Each run prints an `IngestReport` (artifacts, observations, dedup counts) and writes an `ingest.completed`
ledger event. Ingest stops and records `ingest.refused_budget` if the artifact store would exceed
`BLACKGOLD_ARTIFACT_BUDGET_BYTES` (default 40 GiB) — not a concern for 14 daily-bar series.

## Step 2b — load the corporate-action ledger (D-29)

Raw bars are not a ready dataset on their own: the charter's features and every performance/benchmark comparison
run on the adjusted total-return series, which the code recomputes from the raw bars **plus** a corporate-action
ledger (dividends, splits, spin-offs). There is no live feed for these yet, so they are vendored — curated into a
file, each action **reconciled across at least two independent public sources** (issuer distribution notices and
an exchange corporate-action feed), then loaded:

```bash
node packages/core/dist/main.js ingest corporate-actions --file <your-actions.json>
```

The file format is `config/examples/corporate-actions.example.json` (format only — its values are illustrative
and not reconciled; do not ingest it as data). Each `action` object is the stored form validated by the same
parser the read path uses; an entry naming fewer than two sources is flagged `UNVERIFIED_SINGLE_SOURCE`. The
loader needs no credentials and no network — it reads only the local file. Re-loading the identical file
deduplicates. Curating the real dataset for the 14 symbols over the evaluable span (the XLF/XLRE 2015 spin-off is
the acceptance case) is operator work; the ingest mechanism does not create the data.

## Step 3 — measure what actually came back (this is the CR-09 measurement)

Alpaca's free **IEX** feed does not reach back to 2007 — IEX itself is younger than that. **How far back Basic
actually serves daily bars is the exact quantity CR-09 records as unmeasured** ("feed and rate verified; exact
historical-depth limits on Basic to be measured with a key"). The coverage report measures it: `leadingAbsent`
is the count of expected sessions with no bar at the front of the window, and `coverageRatio` is the fraction
present.

```bash
node packages/core/dist/main.js pit count --source alpaca.iex.bars.1d
node packages/core/dist/main.js pit latest --source alpaca.iex.bars.1d --entity VTI
node packages/core/dist/main.js pit latest --source alpaca.iex.bars.1d --entity SPY   # SPY is NOT a charter universe member, so coverage never checks it — verify it here

# Coverage for the design split — read leadingAbsent / coverageRatio / actionCounts per entity
node packages/core/dist/main.js research coverage \
  --path strategies/etf-trend-vol/charter.yaml \
  --from 2007-06-01 --to 2018-12-31

# Coverage for the recent split
node packages/core/dist/main.js research coverage \
  --path strategies/etf-trend-vol/charter.yaml \
  --from 2025-01-01 --to 2026-09-06

node packages/core/dist/main.js artifacts verify --sample 100
```

Two things the coverage report does **not** gate, so check them by hand before calling the dataset ready:

- **Corporate actions.** Coverage reports `actionCounts` per entity but never adds their absence to `uncovered`,
  `belowMinimum`, or `promotionBlockingCodes` — those reflect *bar* coverage and bar quality only. An entity
  with full bars and an empty `actionCounts` therefore looks "adequate" while silently carrying no dividends or
  splits. Confirm the ledger is populated over the window (quarterly dividends should appear):

  ```bash
  node packages/core/dist/main.js pit count --source corporate_action.CASH_DIVIDEND
  node packages/core/dist/main.js pit latest --source corporate_action.CASH_DIVIDEND --entity VTI
  ```

  If these are empty, the D-29 vendoring in the section above has not been done — the dataset is not ready and a
  first result would be a price-return artifact. Stop and flag it.
- **SPY.** The secondary benchmark is outside the charter universe, so it appears in no coverage report. The
  `pit latest … --entity SPY` line above, over the evaluable span, is the only check that it is present and
  current.

From the design-split report, record the earliest actually-served session per entity (window start +
`leadingAbsent` sessions). Update **CR-09** in `docs/CAPABILITY_REGISTER.md` from Partial to Verified with that
date, and note it in `docs/DATA_PROVENANCE_SPEC.md`. That closes the last open capability-register item on the
Stage 1 path.

## Step 4 — the decision this surfaces (owner's, if depth < 2007)

If `leadingAbsent` shows Alpaca serves only from, say, ~2016, the charter's `design` window (2007-06-01 →
2018-12-31) cannot be evaluated as written — roughly its first two-thirds has no bars. That is a real decision
and it is the owner's, not a code fix:

1. **Accept a shorter design period** bounded by Alpaca's actual earliest date — a documented scope note, but
   note the charter's `minimum_independent_decisions: 150` and walk-forward window still have to be satisfiable
   inside the shorter span.
2. **Source deeper history** (a different free daily-bar provider with distributions, or issuer data) — this is
   a new data source, hence a **new strategy version** under the versioning rule, not an edit to the signed
   charter.
3. **Revise the charter boundaries** — also a new charter version at DRAFT; the current signed charter stays as
   it is.

Whichever way it goes, it is recorded as a decision in `docs/DECISIONS.md` before any result is registered.
Claude Code can prepare the options and the numbers; the choice among them is the owner's.

## Step 5 — snapshot, then stop

Only once the dataset is actually ready — which is more than bar coverage: `uncovered` empty, `belowMinimum`
empty, no `promotionBlockingCodes`, **and** the corporate-action ledger populated over the span (non-empty
`actionCounts` / `pit count` on `corporate_action.CASH_DIVIDEND`), **and** SPY present and current — create a
reproducibility snapshot and stop:

```bash
node packages/core/dist/main.js snapshot create --dataset prices_daily --description "first ETF pull <date>"
```

Registering the experiment and computing the first walk-forward result is the next action, and it is a
deliberate Phase 2 stop point — `PLAN.md` Phase 2 ends by handing the predeclared research report to the owner
to accept, reject, or revise. Do not register-and-view in the same unattended session that ingested the data;
an agent that grades its own first result against a charter is the exact failure mode the integrity model
guards against.

## Quick reference — what blocks what

| To do this | You need | Owner-gated? |
|---|---|---|
| Ingest bars | Alpaca key + secret, SEC UA contact | No |
| Coverage report | Ingested bars | No |
| Close CR-09 | The design-split coverage numbers above | No (record the measured date) |
| Adjusted total-return series (features + performance) | The corporate-action ledger, vendored per D-29 (no ingest-CLI source yet) | No, but a data/code prerequisite |
| A *ready* dataset | Bar coverage **and** corporate-action ledger **and** SPY present | No |
| Choose the design-window disposition if depth < 2007 | The coverage numbers | **Yes** |
| Register an experiment | A ready dataset, `registrable: true` charter | Deliberate Phase 2 stop point |
| Open the sealed holdout | The holdout protocol | **Yes — once only, logged** |
