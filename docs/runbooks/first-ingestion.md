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
app environment (`~/umbrel/app-data/blackgold-trading/.env`) and the commands below run inside the app
container — see `umbrel-install-update-remove.md`, "Provide research-data credentials and run the first ingest
on the Pi", for the exact `.env` path and `docker exec` procedure. For a local run, an untracked `.env` sourced
into the shell:

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

**The file must carry the owner's signature (D-57).** Every file has an `approval` block:

```json
"approval": { "approvedBy": null, "approvedAt": null, "actionsHash": "sha256:<64 hex>" }
```

`actionsHash` is the sha256 of the `actions` array exactly as written. The D-57 reconciler fills it in when it
writes a file; for a hand-curated file, compute it with `corporateActionsHash` in
`packages/core/src/data/adapters/corporate-actions.ts`. Ingest refuses the whole file, writes no artifact and
no observation, and records `ingest.refused_unapproved` in the ledger with the reasons, when any of these is
true:

- `approvedBy` is null or blank;
- `approvedAt` is null, or is not a full UTC instant such as `2026-10-06T00:00:00Z` (a date alone is refused);
- `approvedAt` is later than the ingest;
- the actions no longer hash to `actionsHash`, because an amount was edited or an action was added, removed or
  reordered after approval.

The owner fills `approvedBy` and `approvedAt` after auditing the file against the reconciler's report. Claude
Code never does. Editing an action afterwards invalidates the signature, so make corrections first, recompute
the hash, then sign.

### Where the second source comes from (D-58)

The reconciler compares Tiingo's records with an issuer's. Per D-58, an issuer source arrives in one of three
ways.

**Fetched by Black Gold:** State Street (XLK XLF XLV XLI XLP XLU XLY, BIL, SPY). This covers distributions, plus
splits read from each fund's NAV history.

**Downloaded by you, in a browser, then passed as files.** Black Gold never fetches these, because the sites'
terms bar automated access.

- **IWM:** on the iShares Russell 2000 ETF page, choose "Detailed Holdings and Analytics". It saves as
  `iShares-Russell-2000-ETF_fund.xls`.
- **VTI, VTV, VUG:** open each URL below and save the JSON it shows. The file does not name its fund, so keep the
  fund in the file name.

  ```
  https://advisors.vanguard.com/investments/products/api/funds/0970/pricing/distributions   (VTI)
  https://advisors.vanguard.com/investments/products/api/funds/0966/pricing/distributions   (VTV)
  https://advisors.vanguard.com/investments/products/api/funds/0967/pricing/distributions   (VUG)
  ```

  These reach back only to late 2016.

**Curated by you,** for what no feed reaches. Record each distribution from the issuer's own documents (annual or
semi-annual reports, distribution notices) in a CSV laid out like
`config/examples/curated-corporate-actions.example.csv`.

**Wait for the reconcile report before you start.** It lists every action only Tiingo reports, by fund and
ex-date, and that list is exactly what needs a curated row. Look each one up in the issuer's document and record
what the document says, not Tiingo's figure: a copied number is one source counted twice.

The ranges below cover each window plus its **feature warm-up**. The longest feature needs 253 sessions, so the
code reads bars and corporate actions 435 calendar days before a window's first decision. The RECENT warm-up
therefore reaches into 2023. That is not opening the holdout: evaluation already reads those bars, and a
dividend missing from a warm-up would quietly understate every early momentum reading.

- **VTI, VTV and VUG:** every distribution with an ex-date from late March 2006 through 2016-11-30, about 43 per fund.
  Add VTI's June 2008 split as a `SPLIT` row.
- **QQQ:** every distribution with an ex-date from late March 2006 through 2018-12-31, or from late October 2023 through 2026-09-06, about 63.
  Nothing in between: no decision reads it. If Invesco's QQQ page offers a distribution-history download, save
  that instead; a reader for it is a small addition and saves the typing.

That is about 190 rows. In each row:
- `value` is the TOTAL per share that went ex that day, income and capital gains summed;
- `source` names the publisher, e.g. `issuer:vanguard-annual-report`;
- `document` names the page the number came from.

The reconciler checks each row against Tiingo. One that agrees is verified; one that does not is written
single-sourced and listed in the report for you to settle.

**Structural actions** (spin-offs, mergers, delistings) go in a separate JSON file, laid out like
`config/examples/curated-structural.example.json`. It holds the XLF → XLRE spin-off, which needs:
- its ratio and date checked against State Street's notice;
- **XLRE's first close** (`childFirstClose`). It is required: without it the spun-off value never reaches XLF's
  total return.

Other structural actions have the same kind of rule: a merger must be cash-only, and a delisting must state
`finalPrice`, as `"0"` if holders got nothing. The total-return series cannot value the alternatives, so ingest
refuses them.

The reconciler writes each structural action as given.

**Classify every same-day record.** Any source may report a cash or split record on a structural action's entity
and date, and each one must be listed:
- under `supersedes` if it *is* the structural action in another guise. For example, State Street lists the
  spin-off's share ratio in its dividend column. These are set aside.
- under `keeps` if it is a separate, genuine action. These are reconciled as usual.

The reconciler refuses to run while any such record is unclassified, and names each one.

**A merger or delisting also classifies everything after it.** The total-return series ends a merged fund the day
before the merger takes effect, and a delisted one on its last trade date, and ignores anything dated later. So
every cash or split record after that point, the merger's own date included, must be listed under the terminal
action's `supersedes`; it cannot be kept. If it is a real payout, add it to the merger's `terms.cashPerShare` or the
delisting's `finalPrice` first.

Name a record on a later date with its `exDate`, for example
`{ "source": "vendor:tiingo-eod", "kind": "CASH_DIVIDEND", "exDate": "2016-09-21" }`. Without one, a selector means
the action's own date. A delisting can therefore keep a genuine dividend on its last trade date and supersede a
later payout from the same source.

### Building the file: `reconcile corporate-actions` (D-57, D-58)

Run it against the **research store**, the data directory where `ingest tiingo-actions` has run. Tiingo's records
are read from there and written nowhere else. It needs `BLACKGOLD_SEC_USER_AGENT_CONTACT`, because it fetches
State Street through the allowlisted client.

```bash
node packages/core/dist/main.js reconcile corporate-actions \
  --charter strategies/etf-trend-vol/charter.yaml \
  --out reconciled-1.json --report reconciled-1.report.json \
  --vanguard VTI=vti.json,VTV=vtv.json,VUG=vug.json \
  --ishares IWM=iShares-Russell-2000-ETF_fund.xls \
  [--curated curated.csv] [--structural structural.json]
```

**What it reads:**
- The charter sets the scope: its universe, cash and benchmarks.
- It also sets the windows: DESIGN and RECENT, each with the feature warm-up in front. The holdout's middle is
  never read.

**What it writes:**
- Two new files, which it never overwrites: an existing path is refused, so a signed file can't be clobbered.
  - the unsigned vendored file;
  - its report.
- A raw artifact for every input.
- One `corporate_actions.reconciled` ledger event.

It appends no observation to any store.

**The loop:**

1. **Run it once without `--curated`.** The report's `toCurate` lists every action only Tiingo reports.
2. **Curate those rows from the issuers' documents.** Then rerun with `--curated`, writing to new paths. Each run's
   `toCurate` shrinks to what is left.
3. **Audit the final file against its report.** Check these sections:
   - `reconcile.disagreements`: sources that disagree;
   - `reconcile.oneSided`: actions only one source reports;
   - `reconcile.setAside`: records set aside beside a structural action;
   - `reconcile.structuralOutOfScope`: curated structural actions left out, and why;
   - `issuer.ssgaNavHistory`: splits, jumps and gaps;
   - `issuer.ssgaPayDateDropped`;
   - `vendor.revisedActions`.
4. **Sign it:** fill `approval.approvedBy` and `approval.approvedAt`.
5. **Ingest it into a fresh evaluation data directory** that has never had `ingest tiingo-actions` run against it
   (D-57(b)). Load the bars with `ingest universe --actions none`, then
   `ingest corporate-actions --file reconciled-N.json`, then take the snapshot.

An action still single-sourced when you sign stays flagged on ingest, and any run that touches it stays uncitable.

## Step 2c — or load corporate actions automatically from Tiingo (D-49, research-only)

If you are pulling bars from Tiingo (`ingest tiingo-bars`, deeper history than the free IEX feed — see
`docs/DECISIONS.md` D-49) you can extract the corporate actions from the **same prices payload** instead of
curating a file. Tiingo's daily rows carry `divCash` and `splitFactor`; `ingest tiingo-actions` turns them into
`CASH_DIVIDEND` and `SPLIT` observations:

```bash
node packages/core/dist/main.js ingest tiingo-actions \
  --symbols VTI,QQQ,IWM,VTV,VUG,XLK,XLF,XLV,XLI,XLP,XLU,XLY,BIL,SPY \
  --start 2006-04-01 --end 2026-09-06
```

Tiingo is a **single source**, so every action it produces is flagged `UNVERIFIED_SINGLE_SOURCE`: it feeds the
total-return series for research and decisions, but any run that touches it is **barred from promotion evidence**
by the quality policy. This is the fast path to a research-grade total-return dataset; the operator-curated,
two-source vendored file in Step 2b remains the only promotion-eligible corporate-action source. Use one path or
the other for the universe, never both — they share the `corporate_action.<KIND>` source ids and would
double-count a distribution if mixed. The feed names no announcement or pay date, so `availableAt` is the
conservative ex-date start, `payDate` defaults to the ex-date, and `qualified` defaults to false; the TR series
reads only ex-date and amount, so these defaults do not affect returns.

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

## Step 6 — run the evaluation (numbers to review, never a promotion)

Once the dataset is ready, `research evaluate` computes the deterministic backtest over the charter's design,
walk-forward and recent splits and emits a per-split result report. It **never** touches the sealed holdout
(`splitPlan` excludes it and throws if any split overlaps it), and it does not register an experiment or open
the holdout — those stay owner-gated. Use `--source` to score against a specific bars source (e.g. the Tiingo
default):

```bash
node packages/core/dist/main.js research evaluate \
  --path strategies/etf-trend-vol/charter.yaml \
  --source tiingo.eod.bars.1d
```

Read the envelope: each split carries its `reportId`, `reportHash`, `resultHash`, the primary metric with its
bootstrap interval and pass/fail, and both arms (`B1_DETERMINISTIC` vs the `B0_PASSIVE` baseline). Two fields
decide whether a run can back a decision:

- `registrable` — whether the charter itself may be registered (approval + resolved open decisions).
- `citableAsEvidence` / `promotionBlockingCodes` — a run is citable only when it is integrity-clean **and**
  free of promotion-blocking data codes. A dataset built from a single source reports
  `promotionBlockingCodes: ["UNVERIFIED_SINGLE_SOURCE"]` and `citableAsEvidence: false` even under an approved
  charter (D-49): the numbers are usable for research and for the owner's judgement, never as promotion
  evidence. The ≥2-source reconciled corporate-action path (D-29) is what lifts that block.

This produces numbers for the owner to review; it is not a green light to register or to trade. Registering the
experiment and citing a result remain the deliberate Phase 2 stop point above.

## Quick reference — what blocks what

| To do this | You need | Owner-gated? |
|---|---|---|
| Ingest bars | Alpaca key + secret, SEC UA contact | No |
| Coverage report | Ingested bars | No |
| Evaluate (backtest over design/walk-forward/recent splits) | A ready dataset, a charter file | No (numbers only; single-source data is reported uncitable) |
| Close CR-09 | The design-split coverage numbers above | No (record the measured date) |
| Adjusted total-return series (features + performance) | The corporate-action ledger, vendored per D-29 (no ingest-CLI source yet) | No, but a data/code prerequisite |
| A *ready* dataset | Bar coverage **and** corporate-action ledger **and** SPY present | No |
| Choose the design-window disposition if depth < 2007 | The coverage numbers | **Yes** |
| Register an experiment | A ready dataset, `registrable: true` charter | Deliberate Phase 2 stop point |
| Open the sealed holdout | The holdout protocol | **Yes — once only, logged** |
