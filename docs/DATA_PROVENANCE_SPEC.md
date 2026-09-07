# Black Gold Data Provenance Specification

Status: Discovery Pack draft, 2026-09-06. Owner: Matt Herman. Implemented in Phase 1; extended in Phase 5 for production ingestion.

Black Gold's research kernel is only as credible as its answer to one question: at the moment a historical decision was made, exactly what did the system know, and can we prove nothing else leaked in? This document defines the observation contract, the decision-time query rule, source-specific release-lag encodings, price and corporate-action handling, universe snapshots, the raw artifact store, data-quality rules, storage budgets, and the temporal fixtures that Phase 1 must pass before any backtest result is allowed to influence a promotion decision.

Related documents: `docs/THREAT_MODEL.md` (leakage as an attack path), `docs/EXPERIMENT_PROTOCOL.md` (snapshot IDs and holdout), `docs/CONTEXT_PROVENANCE.md`.

## 1. The `PointInTimeObservation<T>` contract

Every normalized record produced by any adapter conforms to this shape. Adapters are deterministic: same raw artifact plus same `parserVersion` yields byte-identical output.

```ts
type PointInTimeObservation<T> = {
  sourceId: string;          // allowlisted source key, e.g. "sec.edgar.submissions"
  sourceLocator: string;     // URL, accession ID, series ID + vintage, or file path in the artifact store
  entityId?: string;         // CIK, ticker-at-date, FIGI, series ID, contract code
  observedAt?: string;       // UTC ISO-8601
  effectiveAt?: string;      // UTC ISO-8601
  availableAt: string;       // UTC ISO-8601, required
  vintageAt?: string;        // UTC ISO-8601
  ingestedAt: string;        // UTC ISO-8601, required
  rawContentHash: string;    // "sha256:<hex>" of the raw artifact this record was parsed from
  adapterVersion: string;    // semver of the fetch/adapter module
  parserVersion: string;     // semver of the parse/normalize module
  value: T;
  qualityFlags: string[];    // reason codes from section 8
};
```

### Precise definitions

| Field | Definition | Example |
|---|---|---|
| `observedAt` | The instant the underlying real-world measurement was taken or the event occurred. For a bar, the bar close. For a Form 4, the transaction date. For COT, the Tuesday position date | Form 4 transaction executed 2026-03-10 |
| `effectiveAt` | The instant the value applies to or the period it describes. For monthly CPI, the reference month (encode as first instant of the period in UTC). For a corporate action, the ex-date | CPI for February 2026: `2026-02-01T00:00:00Z` |
| `availableAt` | The earliest instant a diligent public observer could have obtained this exact value from this source. This is the field the decision engine filters on. It is never the period date, never the transaction date, and never the ingestion time | Form 4 EDGAR acceptance timestamp 2026-03-12T21:14:07Z |
| `vintageAt` | For revisable series, the identifier of the revision this value belongs to. Two records with the same `effectiveAt` and different `vintageAt` are different observations. Absent for sources that never revise | ALFRED `realtime_start` 2026-03-13 |
| `ingestedAt` | When Black Gold fetched and stored the raw artifact. Used for operations and audit only. Never used in a decision query | 2026-09-06T02:11:40Z |
| `rawContentHash` | SHA-256 of the uncompressed raw artifact bytes as received. Links the record to the artifact store and makes reparsing verifiable | `sha256:9f2a...` |
| `adapterVersion` | Version of the code that fetched the artifact. Changing headers, endpoints, or pagination bumps it | `1.4.0` |
| `parserVersion` | Version of the code that turned raw bytes into `value`. Any parsing change, including bug fixes, bumps it, and all affected records are reparsed and stored as new rows | `2.0.1` |
| `qualityFlags` | Zero or more reason codes. An empty array means the record passed every rule at parse time | `["LATE_FILING", "AMENDED"]` |

Rules that follow from the definitions:

1. `availableAt >= observedAt` and `availableAt >= effectiveAt` whenever both are present. A violation is a parser bug and is rejected at write time.
2. `ingestedAt >= availableAt` for live ingestion. For backfills `ingestedAt` is later than `availableAt` by months or years; that is expected and is why `ingestedAt` is never a decision input.
3. When the true `availableAt` is unknown, the adapter must use a conservative upper bound (the latest plausible release instant) and set flag `AVAILABLE_AT_ESTIMATED`. It must never default to `observedAt`.
4. All timestamps are stored as UTC strings. `America/Chicago` appears only in reports and notifications.

## 2. Decision-time query rule

A decision at `decisionAt` may read an observation only if

```text
availableAt + processingDelay <= decisionAt
```

where `processingDelay` is a per-source configured interval representing realistic fetch, parse, and model latency. Defaults: 15 minutes for EDGAR and market data, 60 minutes for macro releases, 24 hours for anything routed through a batch inference job. `processingDelay` is part of the experiment definition and is recorded in the experiment registry; a backtest run with a zero delay is labelled `OPTIMISTIC_DELAY` and cannot be promotion evidence.

For revisable series the query additionally selects the row with the greatest `vintageAt` such that `vintageAt + processingDelay <= decisionAt`. The current-vintage row is never the default.

The query is implemented once, in a single repository function, and every strategy, feature builder, and evidence-packet builder goes through it. Direct table access from strategy code is a CI policy failure (see `docs/THREAT_MODEL.md`, section 8).

## 3. Source-specific release-lag encodings

### SEC EDGAR

- Interfaces: `data.sec.gov` submissions JSON, XBRL company facts and frames, and the archives full-text index. No scraping of rendered pages.
- `availableAt` is the EDGAR acceptance datetime (`acceptanceDateTime` in submissions JSON), converted from US/Eastern to UTC. Filings accepted after 17:30 ET are disseminated the next business day at 06:00 ET; encode `availableAt` as the dissemination instant, not the acceptance instant, and set flag `AFTER_HOURS_ACCEPTANCE`.
- `sourceLocator` is the accession number in canonical form `0001234567-26-000123`. Preserve the raw hash of every primary document and the complete submission text file.
- Rate limit: a single global token bucket of 10 requests per second across all Black Gold processes and hosts. Declared `User-Agent` in the form `BlackGold/<version> (<contact email>)`. Use `If-Modified-Since` and local caching so backfills do not refetch.
- Amendments (`10-K/A`, `4/A`) are separate observations linked to the original by `entityId` plus accession reference; flag `AMENDED` on the original once an amendment is known, with the amendment's `availableAt` recorded so the flag itself does not leak.

### Form 4 (insider transactions)

- Filing deadline is two business days after the transaction. Insiders sometimes file late.
- `observedAt` is the transaction date. `availableAt` is the EDGAR acceptance/dissemination instant as above. A strategy that keys off transaction date is leaking up to two business days plus any lateness.
- Flag `LATE_FILING` when `availableAt` exceeds the deadline computed from the exchange calendar. Late filings are still valid observations; the flag exists for research on late-filer behaviour and for quality reporting.

### FRED and ALFRED

- Historical research must use real-time vintages. Fetch `fred/series/observations` with `realtime_start` and `realtime_end` set to the vintage window, or enumerate vintages with `fred/series/vintagedates`, and store one row per vintage.
- `effectiveAt` is the observation period. `vintageAt` is `realtime_start` of the vintage. `availableAt` is the release instant: use the FRED release calendar (`fred/release/dates`) where available, otherwise `realtime_start` at 12:30 UTC (08:30 ET, the common release time) with flag `AVAILABLE_AT_ESTIMATED`.
- The current revised value is stored like any other vintage. It is never privileged.

### CFTC Commitments of Traders

- Positions are as of Tuesday. Public release is Friday 15:30 ET (19:30 or 20:30 UTC depending on DST). Holiday weeks shift release; use the CFTC release schedule, not an assumed Friday.
- `observedAt` is the Tuesday position date. `availableAt` is the actual release instant. Store both. A backtest that uses Tuesday as the availability date sees three days into the future.
- Source: the CFTC public reporting API (Socrata-style). Works without a token as of 2026-09-06; register for a token if throttled.

### Form 13F

- Due 45 days after quarter end. Holdings are as of quarter end and are typically stale by 45 to 135 days when first public.
- `effectiveAt` is quarter end. `availableAt` is the EDGAR acceptance/dissemination instant.
- Policy: 13F data is research context only. It may appear in an evidence packet as background. It is not an input to any deterministic signal in Phase 2 and is excluded from the Alpha Charter feature list unless a separate charter argues for it with the lag fully encoded.

### Treasury, BLS, BEA

- Preserve the scheduled release instant and the actual release instant separately. `availableAt` is the actual. Flag `RELEASE_DELAYED` when they differ by more than five minutes (government shutdowns and technical delays happen).
- Revision status is a first-class field in `value` (`preliminary`, `revised`, `final`) with `vintageAt` per revision.
- Surprise inputs (actual minus consensus) are permitted only when the consensus source is contemporaneous, licensed for this use, and stored with its own `availableAt` strictly before the release. Without such a source, no surprise feature exists.
- Treasury yield curve: daily par yields published on the Treasury site after 15:30 ET close. `availableAt` is the publication instant, estimated at 16:00 ET if not logged, with `AVAILABLE_AT_ESTIMATED`.

### Market data

- Every bar and quote carries `sourceId` identifying venue and entitlement. A single-venue IEX quote is labelled `iex` and must never be labelled `NBBO`, used as a consolidated spread proxy, or presented as a fill price in a simulator that claims consolidated liquidity.
- Daily bars from a free provider have `observedAt` at session close (from the exchange calendar, so early closes are 13:00 ET) and `availableAt` at provider publication, conservatively the close plus 60 minutes with `AVAILABLE_AT_ESTIMATED` unless the provider timestamps its publication.
- In `PAPER`, `LIVE_MANUAL`, and `LIVE_LIMITED` modes, an executable intent requires a broker quote obtained immediately before submission. Its `availableAt` and `sourceId` are persisted with the intent.

## 4. Prices: raw versus adjusted

Two series are maintained and never mixed.

| Series | Purpose | Content | Adjustment |
|---|---|---|---|
| Raw execution series | Fill simulation, order sizing, share-quantity arithmetic, stop distances | Unadjusted open/high/low/close/volume as printed on the date | None. A pre-split price is the price a trader would have paid |
| Adjusted total-return series | Research features, performance measurement, benchmark comparison | Close adjusted for splits and with dividends reinvested at the ex-date close | Recomputed from the raw series and the corporate-action ledger by Black Gold's own code, not taken from a provider's adjusted column, so the adjustment is reproducible and versioned |

A share quantity is always computed from the raw series. A return is always computed from the total-return series. A CI test constructs a split-and-dividend fixture and asserts that simulated P&L from raw fills plus the cash dividend ledger equals the total-return series result within rounding.

## 5. Corporate action event types

Corporate actions are explicit records, each a `PointInTimeObservation<CorporateAction>` with `effectiveAt` as the ex-date or effective date and `availableAt` as the announcement or first public record instant.

| Type | Required fields | Effect on raw series | Effect on total-return series | Effect on positions |
|---|---|---|---|---|
| `SPLIT` | ratio, ex-date | None (raw is raw) | Divide prior prices by ratio | Multiply held quantity; recompute stop levels; invalidate open protective orders and mark `PROTECTION_PENDING` |
| `CASH_DIVIDEND` | amount, ex-date, pay-date, qualified flag | None | Reinvest at ex-date close | Cash ledger entry on pay-date; tax lot record |
| `SYMBOL_CHANGE` | old symbol, new symbol, effective date | Continuity via stable `entityId` | Continuity | Position re-keyed; restricted-list match re-evaluated against both symbols |
| `MERGER` | acquirer, terms (cash, stock, mixed), effective date | Target series ends | Target return realized at terms | Position converted or cashed; counts as a delisting for universe purposes |
| `SPINOFF` | parent, child, ratio, ex-date | Parent raw unchanged | Parent adjusted for spun value; child series begins | New position appears; restricted-list and look-through checks run on the child before it can be held past the next session |
| `DELISTING` | last trade date, reason, final price if any | Series ends | Final return includes last price or zero if bankruptcy with no recovery | Position marked; backtest must realize the loss, not drop the name |
| `STALE_BAR` | date, reason | Bar flagged, not deleted | Return computed across the gap | No trading on a stale bar in simulation |
| `CORRECTED_BAR` | date, prior hash, new values | New row with new `vintageAt`; old row retained | Recompute forward | Any decision made on the old bar keeps its record pointing to the old hash |

## 6. Universes and the survivorship rule

- A universe is a named set with date-effective membership snapshots. Each snapshot is `PointInTimeObservation<UniverseSnapshot>` with `effectiveAt` as the membership date and `availableAt` as when that membership was public.
- A current constituent list may seed only a frozen liquid ETF universe (the operational track). It may never be projected backwards as historical membership.
- Survivorship rule: any backtest whose universe at any decision date includes a name selected using information about its later existence is labelled `SURVIVORSHIP_BIASED`. Results carrying this label are exploratory. They cannot be cited in an Alpha Charter, cannot satisfy a Phase 2 exit criterion, and cannot support promotion to `PAPER` or beyond. The experiment registry enforces this by refusing to mark such a run as promotion evidence.
- Delisted names remain in historical snapshots with their `DELISTING` record. Free survivorship-free equity data are rarely available; until a justified dataset exists, equity backtests are exploratory and the ETF universe is the only promotable track.

## 6a. Entity identity

Tickers are not stable identifiers. Every observation about a security resolves to a stable internal `entityId` through a date-effective mapping table.

- The mapping table is itself point-in-time: `(symbol, effectiveFrom, effectiveTo) -> entityId`, populated from `SYMBOL_CHANGE`, `MERGER`, `SPINOFF`, and `DELISTING` records and from the SEC company tickers file (CIK to ticker) with its own `availableAt`.
- For SEC sources the natural key is CIK. For market data it is the symbol at that date. For ETFs the issuer's fund identifier is preferred where public; otherwise the symbol at date.
- A ticker that maps to two entities on the same date (reused symbol after a delisting) is resolved by date range. Failure to resolve yields `UNKNOWN_ENTITY` and the row is excluded.
- Restricted-list entries are stored against `entityId` and against every symbol the entity has carried, so a symbol change cannot make a restricted name eligible.

## 6b. Provenance inside evidence packets

Every fact the runtime model receives is a reference, not free text. A sealed evidence packet lists `(observation row ID, rawContentHash, sourceLocator, availableAt)` for each item and includes the extracted text under a delimiter. The model's `ResearchAssessment` cites by observation row ID; citation verification checks that each cited ID was in the packet and that its `availableAt + processingDelay <= decisionAt`. A citation to anything else fails validation and the assessment abstains. The packet hash, model ID, prompt version, and cost are written to the decision record so any historical assessment can be reproduced or shown to be contaminated.

## 7. Raw artifact store

- Location: `${APP_DATA_DIR}/data/artifacts/`, outside git.
- Content-addressed: path is `sha256/<first 2 hex>/<next 2 hex>/<full hex>.zst`. The hash is of the uncompressed bytes as received, so it matches `rawContentHash`.
- Compression: zstd, level 9 for backfill, level 3 for live ingestion. Filings compress roughly 5 to 10x; JSON macro responses 10 to 20x.
- Metadata table in SQLite: hash, byte size raw and compressed, MIME type, first `sourceLocator`, first `ingestedAt`, fetch headers (ETag, Last-Modified), reference count from observations, retention class.
- Deduplication by hash. A refetch that yields identical bytes creates no new artifact; it updates last-verified time only.
- Immutable by convention: the store has no update path in code. A daily job verifies a random sample of artifacts against their hashes and reports mismatches as an incident. The ledger's daily seal covers the metadata table.
- Every observation references exactly one artifact by hash. An observation whose artifact is missing is flagged `ARTIFACT_MISSING` and excluded from decisions.

## 8. Data-quality rules and reason codes

Rules run at parse time and again at the daily quality job. Every rule has a code, a severity, and a decision effect.

| Code | Severity | Trigger | Decision effect |
|---|---|---|---|
| `AVAILABLE_AT_ESTIMATED` | Info | Release instant inferred from a calendar or default | Allowed; experiment report shows share of estimated rows |
| `AFTER_HOURS_ACCEPTANCE` | Info | EDGAR acceptance after 17:30 ET | Allowed; `availableAt` already shifted |
| `LATE_FILING` | Info | Form 4 filed after deadline | Allowed |
| `AMENDED` | Warn | A later amendment exists | Allowed; strategy may prefer amended values only after their own `availableAt` |
| `RELEASE_DELAYED` | Warn | Actual release later than scheduled by more than 5 minutes | Allowed |
| `STALE` | Warn | Newest available row is older than the source's expected cadence plus grace | New risk blocked for features depending on the source |
| `GAP` | Warn | Missing expected bar or period | Return computed across the gap; flagged in coverage report |
| `OUTLIER` | Warn | Value outside 8 median absolute deviations of trailing window | Allowed but excluded from volatility estimates until confirmed by a second day |
| `SCHEMA_DRIFT` | Error | Raw payload fails the adapter schema | Row not written; incident opened |
| `TEMPORAL_INVERSION` | Error | `availableAt` earlier than `observedAt` or `effectiveAt` | Row rejected at write time; parser bug |
| `DUPLICATE_CONFLICT` | Error | Same `sourceLocator` and `vintageAt` with different `rawContentHash` | Both retained; newer marked `CORRECTED_BAR` or equivalent; decision uses the row available at decision time |
| `ARTIFACT_MISSING` | Error | Referenced artifact absent or hash mismatch | Row excluded; incident |
| `UNKNOWN_ENTITY` | Error | Symbol or CIK cannot be mapped to a stable `entityId` | Row excluded; name cannot enter a universe |
| `SURVIVORSHIP_BIASED` | Label | Universe construction used future membership knowledge | Run is exploratory only |
| `OPTIMISTIC_DELAY` | Label | Experiment ran with zero `processingDelay` | Run is exploratory only |

Unknown, stale, conflicting, or unverifiable state fails closed for new risk. This is the same rule as `docs/THREAT_MODEL.md` T-06 and T-13 applied to data.

## 9. Retention and storage budgets

Budgets are set before any bulk download and benchmarked on the Pi in Phase 1. Numbers below are proposals for Matt to approve.

| Class | Contents | Retention | Budget |
|---|---|---|---|
| Ledger and decisions | Event log, order states, decision records, experiment definitions | Forever. Never pruned to free space | 2 GB over five years |
| Raw filings | EDGAR primary documents and submission text for universe names | Forever for names ever held or evaluated; 3 years for others | 40 GB initial cap; hard stop on ingestion at cap |
| Macro and COT vintages | All vintages | Forever | 2 GB |
| Market bars | Daily raw and derived total-return for the universe | Forever | 1 GB |
| Model evidence packets and responses | Sealed packets, raw responses, costs | Forever for any packet that fed a recorded decision; 1 year otherwise | 10 GB |
| Logs | Structured application logs | 90 days, rotated | 2 GB |
| Backups | SQLite online backups, sealed roots | 30 daily, 12 monthly on device; encrypted copies off device | 20 GB on device |
| Free space floor | Minimum free on the NVMe | Always | 15 percent or 30 GB, whichever is larger. Below the floor: ingestion stops, `HALT_NEW_RISK`, alert. Risk and reconciliation continue |

Daily growth target: under 200 MB on an ordinary day, under 2 GB on a bulk backfill day. Monthly SQLite `VACUUM` and daily WAL checkpoint. Deleting audit or order records to free space is never a permitted action.

## 10. Allowlisted public sources

Additions to this table require a PR that touches the allowlist config, the egress allowlist, and this document, and Matt's merge. Nothing outside this table may be fetched by production code.

| Source | Base URL | Cadence | Lag encoded | Licence / ToS note |
|---|---|---|---|---|
| SEC EDGAR submissions and XBRL | `https://data.sec.gov/` | Continuous | Acceptance and dissemination instant | Public domain. Fair access: 10 req/s, declared User-Agent, no bulk crawling of rendered pages |
| SEC EDGAR archives and full-text index | `https://www.sec.gov/Archives/edgar/` | Continuous | As above | As above |
| FRED / ALFRED | `https://api.stlouisfed.org/fred/` | Per series | `realtime_start` vintages; release calendar | Free API key required; FRED terms of use; attribution; some series have third-party restrictions, respect the per-series licence field |
| CFTC COT public reporting API | `https://publicreporting.cftc.gov/` | Weekly | Tuesday positions, Friday 15:30 ET release | Public domain. No token currently required |
| U.S. Treasury daily yield curve | `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/` | Daily | Publication after close, estimated | Public domain |
| BLS public data API | `https://api.bls.gov/publicAPI/v2/` | Per release calendar | Scheduled versus actual release | Public domain; registration key raises limits; daily query limit applies |
| BEA API | `https://apps.bea.gov/api/` | Per release calendar | Scheduled versus actual release; revision status | Public domain; free key required |
| Exchange calendar (NYSE holidays and early closes) | Vendored data file in repository, verified annually against `https://www.nyse.com/markets/hours-calendars` | Annual | None (schedule data) | Public; vendored so the scheduler has no network dependency |
| Market data: Alpaca (IEX feed on free entitlement) | `https://data.alpaca.markets/` | Intraday and daily | Provider publication, estimated | Alpaca terms; IEX-only unless entitled; must be labelled `iex`, never NBBO |
| Market data: broker quote (Schwab, live modes only) | UNVERIFIED pending `docs/schwab-api-capabilities.md` | On demand | Quote timestamp | UNVERIFIED |
| Company websites and press releases | Per-issuer domains added individually to the allowlist | On demand | Fetch instant as `availableAt` with `AVAILABLE_AT_ESTIMATED` unless the page carries a publication timestamp | Treated as untrusted text; robots.txt honoured; no login walls |

Explicitly not allowlisted and with no adapter: any ISA system (email, SharePoint, Teams, calendars, meeting notes, internal briefs), any paid dataset not separately approved, social media feeds, and any broker page not served by the official API.

## 11. Required temporal test fixtures

Phase 1 exits only when each fixture below passes in CI. Fixtures are deterministic, recorded, and stored under `packages/data/fixtures/temporal/` with the raw artifacts they reference.

| Fixture | Setup | Assertion |
|---|---|---|
| Future observation excluded | Observation with `availableAt` one second after `decisionAt` minus `processingDelay` | Decision query returns zero rows for it; a query with delay set to zero returns it and the run is labelled `OPTIMISTIC_DELAY` |
| Revision leakage sentinel | A FRED series with three vintages where the latest revision flips the sign of a signal | Decision at a date between vintage 1 and vintage 2 sees vintage 1 only; a deliberately planted sentinel value that exists only in the latest vintage never appears in any historical decision record across the whole test suite |
| Form 4 acceptance versus transaction | Transaction Monday, accepted Wednesday 18:10 ET | Not available Monday or Tuesday; available Thursday 06:00 ET dissemination; flags `AFTER_HOURS_ACCEPTANCE` |
| COT release lag | Tuesday positions, Friday release, plus one holiday week with Monday release | Decision on Wednesday sees prior week's report; holiday week uses the schedule, not an assumed Friday |
| 13F lag | Quarter-end holdings filed on day 45 | Not available at quarter end plus 44 days; labelled research-context, absent from feature set |
| Early close | Day before Thanksgiving, 13:00 ET close | Session-relative jobs fire relative to 13:00 ET; a daily bar's `observedAt` is 13:00 ET, not 16:00 ET; a decision scheduled "15 minutes before close" runs at 12:45 ET |
| DST transitions | Second Sunday in March and first Sunday in November | UTC offsets for `America/Chicago` boundary display change correctly; COT release maps to 19:30 UTC in summer and 20:30 UTC in winter; no job fires twice or not at all |
| Split | 4:1 split mid-holding | Raw fills unchanged; held quantity multiplied; total-return series continuous; stop level recomputed; open protection marked `PROTECTION_PENDING` |
| Dividend | Cash dividend with ex-date and pay-date a week apart | Total-return series reinvests at ex-date close; cash ledger credits on pay-date; raw series unchanged |
| Delisting | Name delists at zero recovery mid-backtest | Position realizes full loss; name remains in historical universe snapshot; run is not `SURVIVORSHIP_BIASED` because membership was point-in-time |
| Survivorship label | Universe built from a current constituent list | Run labelled `SURVIVORSHIP_BIASED`; registry refuses promotion-evidence flag |
| Stale bar | Provider returns yesterday's bar for today | Flagged `STALE_BAR`; no simulated trade on that bar; return bridges the gap |
| Corrected bar | Provider corrects a close after the fact | Both rows retained; decision at original time keeps original hash; later decisions use the correction |
| Symbol change | Ticker changes mid-holding | Position continuity via `entityId`; restricted-list evaluation runs on both symbols |
| Temporal inversion rejection | Parser emits `availableAt` before `observedAt` | Write rejected with `TEMPORAL_INVERSION`; incident recorded |
| Artifact integrity | One artifact byte-flipped on disk | Daily verify job detects the mismatch; observations referencing it are `ARTIFACT_MISSING` and excluded |

## 12. Open decisions for Matt

1. Approve the storage budgets in section 9 or adjust before the first bulk EDGAR download.
2. Confirm that 13F remains research context only through Phase 2.
3. Decide whether a paid survivorship-free equity dataset is worth evaluating, or whether the ETF universe is the only promotable track for the foreseeable future.
4. Approve the default `processingDelay` values in section 2, or set more conservative ones.
5. Confirm the `AVAILABLE_AT_ESTIMATED` defaults for Treasury and market-data publication times are acceptable or should be measured during Phase 5 shadow operation and then backfilled as calibrated constants.
