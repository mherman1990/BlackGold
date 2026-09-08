# Changelog

Written for the operator. Each entry states what changed, why it matters, required actions, risk impact, migration, and rollback. The top heading's version must match `package.json`, `blackgold-trading/umbrel-app.yml`, and the compose image tag (CI enforces this).

## 0.1.2

Brings the installed app up to the current codebase. The 0.1.1 image could ingest bars but predated the
risk/compliance/portfolio layer and used an older charter schema, so this is a large catch-up release — the
on-Pi ingest you just ran is part of it.

**What changed**

- **Risk, compliance, and portfolio construction (Phase 4).** Deterministic risk limits and halt states, the
  compliance engine and restricted list, ETF factor look-through, and the deterministic portfolio constructor
  with inverse-volatility sizing. Every hard rule has positive, negative, and boundary tests; unknown or stale
  state fails closed for new risk, and the layer can only ever shrink or block risk, never add it.
- **The decision gate.** New risk is allowed only when halt state, risk limits, and compliance all pass, and
  any position increase must be covered by a passing compliance check — fail-closed by construction.
- **The signed Alpha Charter.** `etf-trend-vol` is owner-signed and frozen (D-48); the current charter schema
  (with the deterministic factor map) now loads on the Pi, so `charter show`/`plan` and `research coverage`
  work against it directly.
- **Corporate-action vendoring (D-29).** `ingest corporate-actions --file` loads a curated, two-source-
  reconciled dividend/split ledger — the input the adjusted total-return series is built from. Raw bars alone
  are a price-return artifact. A single-source entry is labelled `UNVERIFIED_SINGLE_SOURCE`; wiring that label
  through the research path so it actually blocks promotion evidence is a tracked follow-up (it is inert until
  a corporate-action dataset exists, which none does yet).
- **Operator ingest on the Pi.** The compose forwards the free Stage-1 data credentials from the app
  environment, and the runbooks document the on-Pi ingest and coverage procedure.

**Why it matters** — it makes the Pi self-consistent with the research kernel: the deployed 0.1.1 image had an
older charter parser (it rejected the `factors` block) and none of the risk/compliance machinery.

**Required actions**

- Update Black Gold in Umbrel. Your data under `${APP_DATA_DIR}` is preserved.
- To ingest, put the free Stage-1 credentials in `~/umbrel/app-data/blackgold-trading/.env`
  (`docs/runbooks/first-ingestion.md`, `umbrel-install-update-remove.md`). None is a brokerage credential.

**Risk impact** — none to money or accounts. **Live trading remains disabled by construction**: no live-order
path, no broker credential, and no money-movement code exists. The new risk/compliance layer only shrinks or
blocks risk.

**Migration** — database migrations apply automatically on first start; the health output lists them. No
manual step, and runtime data under `${APP_DATA_DIR}` is untouched.

**Rollback** — reinstall the previous version by pinning its tag and digest; runtime data is compatible. Take a
verified backup first (`docs/runbooks/backup-and-restore.md`).

## 0.1.1

First release you can actually look at, and three correctness fixes found by pointing the ingest adapters at
the real APIs for the first time.

**What changed**

- **A read-only HTML status page** at `/`, replacing the plain-text dump. Shows mode and live-absence, ledger
  events and chain integrity, the last daily seal with an age flag, unsealed days, scheduled jobs with missed
  and failed counts, data coverage per source with staleness flags, research-evidence state, and disk and WAL
  use. Self-contained: no script, no outbound request, no external font or image. `/health` is unchanged JSON
  and `/status.txt` keeps the old plain-text view for `curl`.
- **FRED ingest works at all.** FRED refuses any request covering more than 2000 vintage dates and DGS10 has
  5,103, so no long-history daily series could previously be ingested. Requests are now windowed by real
  vintage dates with shared boundaries, which also avoids the silent failure: FRED clips a row's
  `realtime_start` to the requested window, so naive chunking invents vintage dates later than the truth
  (CR-28, CR-29).
- **SEC ingest works at all.** EDGAR's `reportDate` is the scheduled shareholder *meeting* date on a proxy
  statement, so it can be in the future. Using it as `observedAt` claimed a fact effective before it was
  knowable and the temporal-inversion guard refused the whole run, for any issuer that files a proxy.
  `observedAt` now falls back to the filing date, flagged `FORWARD_DATED_REPORT`, with the raw `reportDate`
  kept in the value (CR-30).
- **A diagnosable data-directory error.** An unwritable `/data` previously failed with SQLite's bare "unable
  to open database file". It now names the directory, the uid the process runs as, and the `chown` to run,
  and says the fix belongs on the host side of the mount.
- `release.yml` accepts a `workflow_dispatch` version and creates the release tag itself after checks pass
  (D-38). `release-verify.yml` no longer asserts behaviour a published image cannot have, and now checks that
  a refused run leaves no partially initialised database behind.

**Why it matters**

Two of the four ingest adapters failed on their very first real request despite passing their fixture suites.
Nothing downstream of ingestion could have been trusted before this release, and the status page is the
difference between operating the appliance and guessing at it.

**Required actions**

None beyond updating the app. No configuration changes, no new environment variables.

**Risk impact**

None to capital. Live trading remains absent by construction; no broker credential or order path exists in
this image. The research-integrity risk removed is real: fabricated FRED vintage dates would have made
point-in-time macro reads appear honest while being wrong about when values became knowable.

**Migration**

None. No schema change. `FORWARD_DATED_REPORT` is a new quality code and additive.

**Rollback**

Reinstall 0.1.0. Data written by 0.1.1 remains readable: no stored shape changed. Note that FRED and SEC
ingest do not work on 0.1.0, which is why this release exists.

## 0.1.0

Phase 0 foundation. Not yet released to GHCR or installed on any Umbrel device.

**What changed**

- Workspace with three packages: `shared`, `core`, `broker-gateway`.
- Configuration schemas for app, `risk.yaml`, financial picture, restricted list, and `LIVE_AUTHORIZATION`, with fake-value examples.
- SQLite (WAL) with forward-only migrations, integrity check, online backup, and restore verification.
- Append-only, hash-chained ledger with database triggers that block updates and deletes, and daily seals.
- NYSE exchange calendar computed by rule and verified against the published 2026–2027 schedule.
- Deterministic scheduler with idempotency keys, duplicate and reboot protection, deadlines, and missed-run detection.
- Order state machine with an exhaustive legal-transition table, persisted intents before any side effect, `UNKNOWN` handling, and a synthetic broker with fault injection.
- Sleeve account allowlist and second-layer hard caps in the gateway; live modes rejected by construction.
- Health commands for both roles reporting `liveCapable: false`.
- Umbrel one-app Community App Store manifests, multi-arch Dockerfile, PR CI, tag-gated release workflow, identity and secret checks.

Phase 1 (research kernel, same unreleased version):

- Point-in-time observation store with the decision-time rule, vintages, corrections, snapshots, and append-only triggers.
- Content-addressed zstd artifact store with integrity verification; single allowlisted HTTP egress client.
- Adapters for SEC EDGAR (submissions, Form 4), FRED/ALFRED vintages, CFTC COT, and Alpaca IEX daily bars, fixture-tested, with an `ingest` CLI that enforces the storage budget and never persists credentials.
- Raw and total-return price series with a corporate-action ledger, date-effective entity map, and universe snapshots with the survivorship label.
- Experiment registry (frozen definitions, once-only logged holdout, append-only trial ledger, promotion refusal under exploratory labels), decimal NAV accounting with tax lots, conservative fill simulator, and benchmark engine.
- Sixteen temporal fixtures from the data provenance specification.
- Review corrections: COT release timing on a by-rule U.S. federal holiday calendar verified against the published 2026 schedule; Socrata paging for COT; artifact verification quarantines referencing observations and records an incident; the artifact budget is enforced on every write; configured processing delays reach every point-in-time read (`BLACKGOLD_PROCESSING_DELAYS`); promotion evidence is refused when any trial carries a blocking label; the entity map is bitemporal so a later sync cannot leak into an earlier decision.

Phase 2 (first deterministic Alpha Charter, machinery only, same unreleased version):

- `strategies/etf-trend-vol/charter.yaml`: the machine-readable companion to the prose charter, and the only form the code executes. Every window, rank, cap, cost, boundary and threshold is read from it, so a parameter cannot be changed by editing code.
- Approval gate: an experiment cannot be frozen while the charter's approval block is unsigned, a declared open decision is unresolved, or a conditional universe member is undecided. An undecided conditional member is excluded from the universe, so the charter currently runs 12 risk ETFs rather than 13. A permanent CI gate keeps this true for every tracked charter.
- Feature engine reading only through `asOf`: 12-1 momentum, trend against a moving average, annualized volatility and covariance in decimal arithmetic, average dollar volume from raw bars. All features at one cross-sectional anchor; a member priced behind that anchor is excluded rather than ranked on a stale price.
- Candidate engine implementing the charter's rule table with hysteresis, the correlated-cluster cap, and a logged deciding rule for every accepted and rejected candidate.
- Deterministic portfolio construction: inverse-volatility weights, per-ETF cap redistributed to a fixpoint, cluster cap, volatility-target scaling that can only shrink, cash floor, whole-share flooring, and a rebalance band.
- Leakage auditor: an independent second check of the decision-time rule over every read a run made, plus checks the store cannot make (a future effective session, a decision loop running backwards, an undeclared processing delay).
- Coverage report measured through `asOf` with a citable report id; walk-forward splits with purge and embargo; a holdout that refuses to yield its window without a stated open.
- Statistics: seeded stationary block bootstrap, deflated Sharpe that refuses to report when its assumptions fail, concentration analysis, and a preregistered regime classifier.
- Attribution: cash-timing versus selection against the exposure-matched benchmark, and an OLS factor regression that reports "not performed" rather than approximating when the data are inadequate.
- Backtest runner with sealed weekly decision records and two independent arms, a robustness harness enumerating the charter's 72-member grid and every cost, delay and missing-data tier, and a result report carrying the protocol's minimum result set plus the charter's own reasons it may not work.
- New CLI: `charter show`, `charter plan`, `research coverage`.

**Why it matters**

Everything later phases rely on for safety is testable now, before any market data, model, or broker exists.

The Phase 2 layer is machinery, not evidence. No experiment is registered, no result has been computed, and the holdout has never been opened, because the charter is a draft and no market data has been ingested. That is the intended state: viewing a result before the charter is frozen would permanently spend a clean first look at the design period, and the code refuses to freeze an experiment on numbers the owner has not approved.

**Required actions**

Installing this release gives you a read-only plain-text status and health page on port 8479 and nothing else. There is no reporting view yet, and nothing to configure: with no charter approved and no credentials supplied, the app runs its scheduler, seals each completed UTC day of its ledger, and reports its own health. Sealing catches up automatically, so powering the Pi off for a few days leaves no permanent gap in the integrity record.

If you are installing to close the two outstanding Phase 0 exit criteria (`docs/PHASE0_REQUIREMENTS_MATRIX.md`):

1. Pull the image on the Pi and on the Windows Docker host, and run `health` for both roles. Both must report `liveCapable: false`.
2. Run `scripts/pi-benchmark.sh` on the Pi and record the numbers against `docs/RESOURCE_BUDGET.md`.
3. Check port 8479 is free on the Pi before the first install (D-04).

Supplying data credentials is optional and separate. `ingest` needs `BLACKGOLD_SEC_USER_AGENT_CONTACT` plus per-source keys; they go in the Umbrel app environment, never in git. Without them the research adapters simply never run.

**Risk impact**

None to capital. No broker connectivity, no credentials, no live path, and no code that could form or route an order. The gateway in this release holds no credential and offers only the synthetic broker; it exposes no port and has no app_proxy route.

**Migration**

Initial schema. Migrations run automatically on start and are forward-only from this release onward.

**Rollback**

Roll back to the previous image tag; there is no previous published tag for 0.1.0, so rollback means removing the app. All mutable state lives under `${APP_DATA_DIR}/data` and is removed with it. No external state exists to reconcile.
