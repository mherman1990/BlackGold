# Access and credentials the operator must prepare

Everything Black Gold needs from the outside world, in the order it is needed, with cost, lead time, and what
each unlocks. Written because this list previously existed only in conversation, and a checklist worked
through over days belongs where the next session can read it.

**Where credentials go.** The Umbrel app environment, or a local `.env` that is never committed. Never a
tracked file, never a fixture, never a prompt, never a log. `.gitignore` root-anchors `.env`, `*.key`,
`secrets/`, `config/local/` and every runtime data path; `npm run check:secrets` scans all tracked files for
credential shapes on every CI run and on every commit.

**What is already true, and does not need protecting again.** No balance, position, ledger row or account
reference can reach git: runtime state lives only under `${APP_DATA_DIR}` on the Pi (`/data/`, `*.sqlite`,
`/artifacts/`, `/backups/`, `/logs/` are all ignored). `docs/THREAT_MODEL.md` classifies the household
financial picture as asset **A3**, stored in local SQLite only, and **T-22** covers dollar totals reaching a
model or an off-device report. The repository holds code, documentation, and the charter - not financial data.
Making the repository private would protect strategy IP, not financial data, because the latter was never
going to be there.

## Stage 1: research data (needed now, all free, no money involved)

These four unblock ingestion, which unblocks every number the research kernel produces. Nothing here touches
a brokerage account or moves a dollar.

| Variable | Source | Cost | Lead time | Notes |
|---|---|---|---|---|
| `BLACKGOLD_SEC_USER_AGENT_CONTACT` | none - just an email address | free | none | SEC fair access expects a declared User-Agent with a contact; unclassified bots are prohibited and rate-limited to 10 req/s regardless of machine count (CR-01). EDGAR fetches refuse to start without it. |
| `BLACKGOLD_FRED_API_KEY` | https://fred.stlouisfed.org/docs/api/api_key.html | free | minutes | Macro **vintages** via ALFRED - `realtime_start`/`realtime_end` are what make point-in-time macro reads honest (CR-04). |
| `BLACKGOLD_ALPACA_KEY_ID` | https://alpaca.markets | free | minutes | **Paper-account keys work for market data**; no funding required. |
| `BLACKGOLD_ALPACA_SECRET_KEY` | same | free | minutes | Free Basic plan is the **IEX** feed, not SIP; 200 historical requests/minute (CR-09). Adequate for daily bars on a small ETF universe. |
| CFTC Commitments of Traders | https://publicreporting.cftc.gov | free | none | **No key.** Public Socrata endpoint, works without a token at present (CR-05). Nothing to prepare. |

Verify with `node packages/core/dist/main.js ingest ...`; the run refuses before any network call if a
required credential is absent, so a missing key fails fast rather than half-ingesting.

## Stage 1 also needs three things only the owner can decide

Not credentials, but they gate results just as hard, and no amount of code removes them. Recorded here
because "waiting on data" is the wrong diagnosis if these are the real blockers.

1. **Sign the Alpha Charter** - `strategies/etf-trend-vol/charter.yaml`. It is `DRAFT`: four declared open
   decisions unresolved, XLE undecided, approval block unsigned. `charter show --path <file>` prints exactly
   what is missing. `assertRegistrable` refuses a DRAFT charter and a CI gate keeps that true, so **no
   experiment can be registered and no result can exist** until this is done.
2. **Confirm or overrule D-32** - book-slot priority between the entry rule and the hysteresis hold rule. The
   prose charter is genuinely ambiguous; the code resolves it in favour of the incumbent and explains why.
3. **Approve `risk.yaml`** - `config/examples/risk.yaml` is an example, not an approved configuration. Phase 4
   depends on an approved one.

Claude Code may not do any of these. That is deliberate and is not workflow friction: an agent that signs the
charter it wrote, then grades its own results against it, produces nothing of evidential value. See "What
standing authorization never covers" in `CLAUDE.md`.

## Stage 2: the LLM overlay (Phase 3)

| Variable | Source | Cost | Lead time |
|---|---|---|---|
| Anthropic API key | https://platform.claude.com | usage-based | minutes |

Budgets already exist and default conservative: `BLACKGOLD_LLM_BUDGET_PER_CALL_USD`, `_PER_DAY_USD`,
`_PER_MONTH_USD`. Cost control is designed in rather than bolted on - Batch API is a 50% discount with most
batches finishing inside an hour (CR-11), prompt caching is measured, and model IDs live in config behind
`ModelAdapter` so a tier change is a config edit and a new strategy version, never a code change (CR-12,
CR-13).

Worth stating plainly: no LLM output may set position size, choose an account, form an executable order, or
override a deterministic rejection. Model confidence is display metadata. So this key buys analysis, not
authority.

## Stage 3: the brokerage account (Phase 6, and the one with real lead time)

**Start this early.** It is the only item on this page whose delay is calendar time rather than work.

| What | Where | Notes |
|---|---|---|
| Schwab developer account | https://developer.schwab.com | Trader API access requires an application and approval. The page returns 403 unauthenticated, so its OAuth flow, token lifetimes, consent scope, preview support, bracket support and rate limits are all still **UNVERIFIED** (CR-10) and gate Phase 6 sizing. |
| A dedicated taxable brokerage account | Schwab | D-12 assumes dedicated. That word is load-bearing - see below. |

### The decision that actually matters: token scope

`docs/THREAT_MODEL.md` **T-01** is the highest-severity risk in the system: a Schwab token may scope to the
whole household rather than to one account, in which case a bug or an attacker in the gateway reaches an IRA
or a spouse account. Code separation is not broker-enforced permission. The gateway's account allowlist,
the sleeve-account hash check, the second independent risk check, and the read-only non-sleeve interfaces all
reduce the chance of a mistake - none of them shrink the blast radius of a compromise.

So before Phase 6 sizing, one question needs an answer from Schwab rather than from code:

> **Can a token be scoped to a single account, or not?**

- **If yes** - use it, and the blast radius is one ring-fenced sleeve as designed.
- **If no** - the household blast radius must be accepted **in writing** (D-13), or automation stays blocked.
  That is a real decision with real money behind it, and it is the owner's alone.

This is why the register row is `UNVERIFIED` rather than assumed: the capability register exists so that
nothing time-sensitive gets coded against a guess.

## What is deliberately not needed

- **No paid data vendor.** Free government and exchange sources are the primary signal layer by design.
- **No funded account** for research, backtesting, or paper trading. Alpaca paper keys are enough through
  Phase 5.
- **No credential of any kind** until Stage 1, and no *broker* credential until Phase 6.
- **No professional-source connector.** No code may connect to ISA email, SharePoint, Teams, calendars, or
  meeting notes. This is a hard boundary, not a configuration choice.

## Order of operations, shortest path first

1. Four Stage 1 credentials (an afternoon at most, all free).
2. Sign the charter, confirm D-32, approve `risk.yaml`.
3. → Phase 2 produces its first real result. **Everything downstream is currently waiting on 1 and 2, not on
   code.**
4. Start the Schwab developer application in parallel with everything above, because approval is calendar time.
5. Anthropic key when Phase 3 begins.
6. Answer the T-01 token-scope question before Phase 6 is sized.
