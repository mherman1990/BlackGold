# Assumptions and gaps

Separates what is known from what is inferred, and lists unknowns and blockers with the phase they block.

## Verified facts (2026-09-06)

| Fact | Evidence |
|---|---|
| `mherman1990/BlackGold` exists, is public, and has zero commits and zero branches | `git ls-remote --heads origin` returned nothing; `git status` shows no commits |
| This session's assigned branch is `claude/black-gold-trading-tool-n713ly` | Session instructions |
| Node 24 is Active LTS; the build container here has Node 22.22.2 and Docker 29.3.1 | nodejs.org; `node --version`, `docker --version` |
| Umbrel store schema, SEC fair access, FRED vintages, CFTC release timing, Alpaca paper omissions, Alpaca order semantics, Anthropic batch window, Claude Code rules behaviour | `docs/CAPABILITY_REGISTER.md` rows marked Verified |
| Schwab developer portal is not readable without login | HTTP 403 on fetch |

## Inferences (reasonable but unconfirmed)

| Inference | Basis | Risk if wrong |
|---|---|---|
| Matt wants Discovery only in this session, not application code | The prompt's §21 says produce the Discovery Pack and stop; "execute" was read as executing the prompt | Low: Phase 0 can start immediately on approval |
| Matt intends `main` to be the default branch | Convention; prompt says "protected `main`" | Low |
| The "external-agent document" was intentionally not attached | It was referenced but not supplied | None; nothing was imported |
| The sleeve is a taxable Schwab account (per the review's default) | Review §D.4 | Medium: IRA changes tax and household modelling (D-12) |
| Matt's ISA role creates MNPI exposure primarily around soybean, biofuel, and ag-input names | Matt's stated role | Medium: restricted seed must be reviewed by Matt and counsel (D-14) |
| Alpaca free market data is IEX-only | Common knowledge; not re-fetched | Medium: affects D-24 |
| Port 8479 is unused on Matt's Pi | Uncommon port | Low: change before install |
| `${APP_DATA_DIR}` remains the umbrelOS data variable | Widely used in official apps; not re-verified | Medium: manifests must not be written until UM-07 resolves |

## Unknowns requiring Matt

| Unknown | Why it matters | Decision |
|---|---|---|
| Is the sleeve account open? Taxable or IRA? At which broker? | Tax model, household model, Phase 6 target | D-12 |
| Does Schwab's consent flow allow sleeve-only linkage? What blast radius does Matt accept? | Blocks unattended automation | D-13 |
| Which apps and ports are installed on the Pi? | Port collision | D-04 |
| Where may encrypted backups live off-device? Who else has Pi access? | RPO/RTO and threat model | D-16 |
| Preferred notification channel (ntfy, Pushover, email, other)? | Phase 5 | D-17 |
| Intended sleeve NAV for paper realism and micro-live caps | Sizing realism | D-18 |
| Is a small paid data budget acceptable if free point-in-time stock data is inadequate? | Stock-track promotion | D-19 |
| Counsel availability for the restricted-list review | Phase 4 exit | D-14 |
| Anthropic API tier and rate limits on Matt's account | Phase 3 deadlines | MP-09 |
| License preference | Phase 0 | D-21 |

## Technical gaps (Claude Code resolves in the named phase)

| Gap | Phase | Method |
|---|---|---|
| Umbrel `${APP_DATA_DIR}`, `exports.sh`, `manifestVersion` semantics (UM-07 to UM-09) | 0 | Inspect `getumbrel/umbrel-apps` and umbrelOS source |
| Multi-arch GitHub Actions build recipe and GHCR anonymous pull (CR-20, GH-08, GH-09) | 0 | Dry-run CI |
| Exchange calendar library and 2026–2027 schedule verification (CR-21) | 0 | Compare against NYSE published holidays |
| SQLite binding choice on ARM64 (`better-sqlite3` prebuilt vs `node:sqlite`) (UM-16) | 0 | Build and smoke test on the Pi |
| Free daily ETF price source with distributions, venue labelled (D-24, CR-09) | 1 | Probe Alpaca data entitlement; evaluate issuer distribution feeds |
| Empirical Form 4 acceptance-lag distribution (CR-23) | 2 | Measure from EDGAR submissions |
| Anthropic latency p95 for a 20–40K packet at low effort (MP-11) | 3 | Measure |
| Alpaca duplicate `client_order_id` semantics (ALP-11) | 5 | Paper probe |
| Every Schwab row (SCH-01 to SCH-14) | 6 | Authenticated read-only spike with Matt |

## Blockers right now

1. No `main` branch: Matt must create it (D-02) before a PR can exist.
2. Identifiers unconfirmed (D-04): Phase 0 must not write manifests until confirmed.
3. License undecided (D-21): minor, but `LICENSE` is part of the Phase 0 bootstrap.

## Explicitly out of scope for Discovery

Application code, CI workflows, manifests, container images, broker or model API keys, any network call to a broker, any Umbrel install.
