# First ingestion — from four credentials to a first coverage report

**Phase 1 → Phase 2. Run this the afternoon the four Stage 1 credentials land.** It takes the repository from
"machinery delivered, no data" to "market data ingested and coverage measured", which is the single step that
`docs/ACCESS_AND_CREDENTIALS.md` names as the one remaining blocker to a first result. It also performs the
CR-09 historical-depth measurement that the capability register still lists as unmeasured.

Nothing here opens the sealed holdout, registers an experiment, or computes a result a DRAFT charter could
cite — those are separate, and the last two are owner-gated (`charter.yaml` is already `APPROVED`, so
registration is unblocked, but registering and then viewing a result is the deliberate stop point Phase 2 ends
at). This runbook stops at a coverage report.

## What this charter's first result actually needs

The `etf-trend-vol` charter runs price-only arms (`arms: [B0_PASSIVE, B1_DETERMINISTIC]`,
`runtime_llm_in_signal: false`). Its features — 252-session momentum, 200-session trend SMA, 63-session
volatility, 20-session ADV — are all derived from daily bars. So the only source a first Phase 2 result needs
is **Alpaca daily bars**. `research coverage` confirms this: it reports against `alpaca.iex.bars.1d` and no
other source.

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

## Step 3 — measure what actually came back (this is the CR-09 measurement)

Alpaca's free **IEX** feed does not reach back to 2007 — IEX itself is younger than that. **How far back Basic
actually serves daily bars is the exact quantity CR-09 records as unmeasured** ("feed and rate verified; exact
historical-depth limits on Basic to be measured with a key"). The coverage report measures it: `leadingAbsent`
is the count of expected sessions with no bar at the front of the window, and `coverageRatio` is the fraction
present.

```bash
node packages/core/dist/main.js pit count --source alpaca.iex.bars.1d
node packages/core/dist/main.js pit latest --source alpaca.iex.bars.1d --entity VTI

# Coverage for the design split — read leadingAbsent / coverageRatio per entity
node packages/core/dist/main.js research coverage \
  --path strategies/etf-trend-vol/charter.yaml \
  --from 2007-06-01 --to 2018-12-31

# Coverage for the recent split
node packages/core/dist/main.js research coverage \
  --path strategies/etf-trend-vol/charter.yaml \
  --from 2025-01-01 --to 2026-09-06

node packages/core/dist/main.js artifacts verify --sample 100
```

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

Once coverage over the evaluable span is adequate (`uncovered` empty, `belowMinimum` empty, no
`promotionBlockingCodes`), create a reproducibility snapshot and stop:

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
| Choose the design-window disposition if depth < 2007 | The coverage numbers | **Yes** |
| Register an experiment | Adequate coverage, `registrable: true` charter | Deliberate Phase 2 stop point |
| Open the sealed holdout | The holdout protocol | **Yes — once only, logged** |
