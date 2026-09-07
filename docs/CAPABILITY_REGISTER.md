# Capability register

Every time-sensitive external claim Black Gold depends on, with its first-party source, access date, confidence, and probe status. Nothing is coded against an `UNVERIFIED` row. Re-verify any row older than 90 days before the phase that depends on it.

Confidence: **Verified** (read on the first-party page on the access date), **Partial** (page read; claim only partly covered), **UNVERIFIED** (could not access first-party source; memory or third-party only).

Detailed per-vendor registers: `docs/capabilities/schwab-api-capabilities.md`, `docs/capabilities/alpaca-api-capabilities.md`, `docs/capabilities/model-provider-capabilities.md`, `docs/capabilities/github-capabilities.md`, `docs/capabilities/umbrel-capabilities.md`.

| ID | Claim | Source | Accessed | Confidence | Probe | Depends |
|---|---|---|---|---|---|---|
| CR-01 | SEC fair access: ≤10 requests/second regardless of machine count; "unclassified" bots prohibited; declared User-Agent expected | https://www.sec.gov/about/developer-resources | 2026-09-06 | Verified | Phase 1: rate-limited fetch of one submissions JSON with UA | Phase 1–2 |
| CR-02 | SEC provides submissions API and XBRL APIs on data.sec.gov (JSON), plus daily/quarterly index files and archives | same | 2026-09-06 | Verified | Phase 1 | Phase 1–2 |
| CR-03 | Form 4 acceptance timestamp available via EDGAR accession metadata | inference from CR-02 | - | Partial | Phase 2: parse `acceptanceDateTime` from submissions JSON | Phase 2 |
| CR-04 | FRED `series/vintagedates` returns revision/release dates; `realtime_start`/`realtime_end` select as-of values | https://fred.stlouisfed.org/docs/api/fred/series_vintagedates.html | 2026-09-06 | Verified | Phase 1: fetch one series at two realtime dates and diff | Phase 1 |
| CR-05 | CFTC COT released Fridays 3:30 PM ET for Tuesday positions; public reporting API works without a token at present | https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm | 2026-09-06 | Verified | Phase 1 | Phase 1 (regime feature only) |
| CR-06 | Alpaca paper omits market impact, information leakage, latency slippage, queue position, price improvement, regulatory fees, dividends; base URL `paper-api.alpaca.markets`; paper accounts are created/deleted, not reset | https://docs.alpaca.markets/docs/paper-trading | 2026-09-06 | Verified | Phase 5 | Phase 5 |
| CR-07 | Alpaca `client_order_id` accepted (auto-generated if absent); bracket/OCO/OTO; TIF `day/gtc/opg/cls/ioc/fok`; GTC auto-cancel after 90 days; fractional day-only; extended hours limit-only; bracket stop qty adjusts on partial TP fill; notional orders not replaceable | https://docs.alpaca.markets/docs/orders-at-alpaca | 2026-09-06 | Verified | Phase 5: duplicate `client_order_id` probe on paper to confirm rejection semantics | Phase 5 |
| CR-08 | Alpaca `client_order_id` duplicate behaviour (idempotent reject vs. new order) | not stated on CR-07 page | - | UNVERIFIED | Phase 5 paper probe required | Phase 5 |
| CR-09 | Alpaca free market data is IEX-only; SIP requires paid subscription | not fetched | - | UNVERIFIED | Phase 1: check data docs and account entitlement | Phase 1 (D-24) |
| CR-10 | Schwab Trader API: OAuth flow, token lifetimes, account consent scope, preview, brackets, rate limits | https://developer.schwab.com (HTTP 403 unauthenticated) | 2026-09-06 | UNVERIFIED | Phase 6 spike with Matt's developer login; read-only probes only | Phase 6–7 |
| CR-11 | Anthropic Message Batches: most finish < 1 h; results available when done or at 24 h; expire at 24 h; 50% discount; 29-day retention; 100,000 requests or 256 MB per batch | https://platform.claude.com/docs/en/build-with-claude/batch-processing | 2026-09-06 | Verified | Phase 3 | Phase 3 (D-22) |
| CR-12 | Current Anthropic model IDs and prices (Haiku 4.5, Sonnet 5, Opus 5, etc.) | Claude Code bundled `claude-api` skill table, cached 2026-06-24; Models API at implementation | 2026-09-06 (skill) | Partial | Phase 3: `GET /v1/models` at config time | Phase 3 |
| CR-13 | Anthropic structured outputs via `output_config.format`; strict tool schemas; prompt caching with `cache_control` | same skill; docs at platform.claude.com | 2026-09-06 (skill) | Partial | Phase 3 | Phase 3 |
| CR-14 | Node.js 24 "Krypton" is Active LTS; 22 "Jod" is Maintenance LTS | https://nodejs.org/en/about/previous-releases | 2026-09-06 | Verified | Phase 0 container build | Phase 0 |
| CR-15 | Umbrel store: `umbrel-app-store.yml` requires `id` and `name`; app id prefixed by store id; app dir has `umbrel-app.yml` + `docker-compose.yml`; store added by GitHub URL | https://github.com/getumbrel/umbrel-community-app-store | 2026-09-06 | Verified | Phase 0 manifest lint | Phase 0 |
| CR-16 | Umbrel example manifest uses `manifestVersion: 1` and the field list in `docs/UMBREL_STORE_AND_RELEASE.md`; compose uses `app_proxy` with `APP_HOST`/`APP_PORT` | template repo raw files | 2026-09-06 | Verified | Phase 0 | Phase 0 |
| CR-17 | `${APP_DATA_DIR}` is the app-data variable in current official apps; images pinned as `tag@sha256:digest`; `manifestVersion: 1` in current apps; a single-app package needs no `exports.sh` (uptime-kuma has none) | https://raw.githubusercontent.com/getumbrel/umbrel-apps/master/uptime-kuma/{docker-compose.yml,umbrel-app.yml} | 2026-09-06 | Verified | Phase 0 install test on the Pi confirms behaviour | Phase 0 |
| CR-18 | Claude Code: `.claude/rules/*.md` with `paths:` frontmatter loads path-scoped; CLAUDE.md is guidance not enforcement; PreToolUse hooks enforce; CLAUDE.md target < 200 lines | https://code.claude.com/docs/en/memory | 2026-09-06 | Verified | - | Discovery |
| CR-19 | Claude Code `--worktree` creates `worktree-<name>` branches | https://code.claude.com/docs/en/worktrees (not fetched this session) | - | UNVERIFIED (from source prompt) | Check when first used | Phase 0 |
| CR-20 | `docker/build-push-action@v7` with `docker/setup-qemu-action@v4` and `docker/setup-buildx-action@v4` builds `platforms: linux/amd64,linux/arm64` with `push: false`; `digest` is an output | https://github.com/docker/build-push-action | 2026-09-06 | Verified (GHCR anonymous pull still to confirm on first publish) | Phase 0 CI run on the PR | Phase 0 |
| CR-21 | NYSE 2026 holidays: Jan 1, Jan 19, Feb 16, Apr 3, May 25, Jun 19, Jul 3, Sep 7, Nov 26, Dec 25; 2027: Jan 1, Jan 18, Feb 15, Mar 26, May 31, Jun 18, Jul 5, Sep 6, Nov 25, Dec 24. Early closes 13:00 ET: 2026-11-27, 2026-12-24, 2027-11-26. Core session 09:30–16:00 ET | https://www.nyse.com/markets/hours-calendars | 2026-09-06 | Verified | Phase 0 fixtures encode these dates; rule engine must reproduce them | Phase 0 |
| CR-22 | 13F filing deadline 45 days after quarter end | statutory (Rule 13f-1); not re-fetched | - | Partial | - | Research context only |
| CR-23 | Form 4 due within two business days of the transaction | statutory (Section 16(a)); not re-fetched | - | Partial | Phase 2: measure empirical acceptance lag distribution | Phase 2 |

## Re-verification schedule

- Before Phase 0: CR-14, CR-15, CR-16, CR-17, CR-20, CR-21.
- Before Phase 1: CR-01, CR-02, CR-04, CR-05, CR-09.
- Before Phase 3: CR-11, CR-12, CR-13.
- Before Phase 5: CR-06, CR-07, CR-08.
- Before Phase 6: CR-10 in full, with Matt present for authenticated access.
