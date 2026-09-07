# Black Gold Automation Ladder and Live Gates

Status: Discovery specification. Defines the six operating modes, the ladder that connects them, the evidence required to climb each rung, the artifacts that authorize live activity, the halt-state machine, and the conditions that push the system back down. Companion documents: `docs/EXPERIMENT_PROTOCOL.md` (how investment evidence is produced), `docs/THREAT_MODEL.md` (what these gates defend against), and each `strategies/<strategy_id>/ALPHA_CHARTER.md` (strategy-specific observation counts and durations).

Two sentences govern everything below. Promotion is never automatic. Demotion frequently is.

## 1. Modes

The mode is a single enum value held by `blackgold-core` and echoed by `blackgold-broker-gateway`. The two processes must agree; disagreement fails closed to the more restrictive mode.

| Mode | May do | May not do | Live credentials |
|---|---|---|---|
| `RESEARCH` | Ingest allowlisted historical and public data, build snapshots, register experiments, run feature and model evaluation on sealed evidence | Produce a decision record with an executable timestamp; touch any broker endpoint | Absent. Binary compiles and runs without them |
| `BACKTEST` | Everything in `RESEARCH` plus run registered experiments over frozen boundaries, write trial-ledger rows, open a holdout under logged authorization | Contact any broker; write to the prospective decision ledger | Absent |
| `SHADOW` | Run the production scheduler on live allowlisted data, seal timestamp-locked decision records for all four arms before outcomes are knowable, compute counterfactual fills with the internal simulator | Send any order to any broker, paper or live; read broker account data | Absent |
| `PAPER` | Everything in `SHADOW` plus submit orders to a broker paper endpoint (Alpaca paper if still approved), reconcile paper fills, run the Steward and reconciler, generate reports and incidents | Hold or load a live broker credential; route to any live endpoint | Absent. Paper credentials only, scoped to the paper base URL |
| `LIVE_MANUAL` | Present each proposed order with thesis, falsifier, incremental risk, cost, restrictions, quote freshness, exact order fields, and approval expiry; submit only after explicit owner approval within the expiry window; reconcile; protect | Submit anything unapproved; submit after approval expiry; act on any account other than the one with role `blackgold_sleeve` | Present, scoped to the sleeve account, and inert unless a valid `LIVE_AUTHORIZATION.yaml` matches |
| `LIVE_LIMITED` | Submit orders for exactly one immutable strategy version without per-order approval, within the authorization's caps | Run more than one strategy version; exceed any cap; run past expiry; run an LLM arm that was not part of the authorized version | Present, scoped, and inert unless a valid authorization matches |

Build rule: `RESEARCH`, `BACKTEST`, `SHADOW`, and `PAPER` compile and run with no live-order code path linked and no live credential present. CI asserts this by building the core package with the live adapter excluded and confirming the mode enum still resolves. The live adapter is a separate module loaded only when the mode is one of the two live modes and a matching authorization has been validated.

All modes exclude options, shorting, margin, leverage, crypto, futures, and extended-hours sessions. These are not mode-gated features awaiting a higher rung; they are absent until a separate written decision adds them.

## 2. The automation ladder

Each rung is a gate with an evidence requirement. Rungs are climbed one at a time, in order, per strategy version. Skipping is not permitted.

| Rung | Mode | Purpose | Exit evidence |
|---|---|---|---|
| 1. Historical research | `RESEARCH`, `BACKTEST` | Establish that the hypothesis is implementable point-in-time and not obviously false | Reproducible data and experiment records; leakage audit passed; benchmarks named; realistic costs applied; robustness suite complete; holdout still unopened or opened once with logged decision |
| 2. Prospective shadow | `SHADOW` | Establish that decisions can be made on time from allowed data, and produce uncontaminated LLM observations | Charter's minimum prospective decision count reached; zero missing decision records; B0/B1/C1/D1 sealed at every eligible timestamp |
| 3. Paper | `PAPER` | Exercise order lifecycle, reconciliation, Steward, and incident handling against a broker simulator | 100% hard-rule enforcement; every paper fill reconciled; paper-versus-internal-simulator gap measured and explained; restarts, missed jobs, rate limits, and provider outages handled within RPO and RTO; no unresolved high-severity incident |
| 4. Broker capability validation | `PAPER` (gateway spike) | Verify the live broker's actual capabilities from official sources; run non-live previews and probes only | Dated capability documents; blockers resolved; account-consent and credential blast radius accepted in writing; gateway account allowlist and second risk check in place; full order-state and fault suite passing on sanitized recorded fixtures; runbooks complete. Any Schwab claim is labelled unverified until confirmed against official documentation |
| 5. Live manual | `LIVE_MANUAL` | Calibrate execution shortfall and the human approval workflow at trivial size | Charter's operational observation count reached; every approval, submission, fill, protection state, reconciliation, notification, shortfall calculation, halt, and recovery verified in the broker application; explicit owner review |
| 6. Live limited | `LIVE_LIMITED` | Run one exact strategy version without per-order approval under small caps | Not an assumed destination. Requires a new written decision showing both scorecards green for the exact immutable version |
| 7. Broader automation | none defined | Deferred | A separate later decision. This document does not specify it and nothing in it should be read as a path toward it |

Rung 5 calibrates execution, not returns. Eight to twelve weeks of micro-live trading does not prove alpha and no report may imply that it does. Investment evidence comes from rungs 1 through 3 accumulated over the durations the charter specifies; rung 5 adds execution evidence only.

## 3. Two independent scorecards

Both scorecards must be green for promotion past rung 4. Neither substitutes for the other: operational safety does not prove edge, and a good quarter does not prove operational safety.

### 3.1 Operational scorecard

| Criterion | Measure | Rung 3 threshold | Rung 5 threshold |
|---|---|---|---|
| Account boundary | Count of any read or write against a non-sleeve account through a mutating interface | 0, ever | 0, ever |
| Hard-rule enforcement | Share of rule evaluations with a matching positive, negative, and boundary test that passed in CI on the running commit | 100% | 100% |
| High-severity incidents | Open incidents at severity high or above | 0 | 0 |
| Restart drill | Scheduler and ledger recover from kill at every job phase without duplicate or missing decision records | Passed in last 30 days | Passed in last 14 days |
| Reconciliation | Share of positions and cash reconciled to broker at each close | 100%, with every break explained within one session | 100%, every break explained same day |
| Backup and restore | SQLite backup, restore, and integrity check | Passed in last 30 days | Passed in last 14 days |
| Data freshness | Share of scheduled ingestion jobs landing inside the charter's freshness window | at least 98% over 30 days | at least 99% over 30 days |
| Job completion | Share of scheduled jobs completing without manual intervention | at least 98% | at least 99% |
| Protection coverage | Share of open sleeve positions with the required protective state present and verified | 100% | 100% |
| Execution calibration | Realized shortfall versus internal simulator estimate | Measured for every paper fill | Within charter tolerance over the rung-5 observation count |
| Authorization validity | Current `LIVE_AUTHORIZATION.yaml` hashes match running system | n/a | Continuously true |

### 3.2 Investment scorecard

| Criterion | Measure | Threshold |
|---|---|---|
| Preregistered strategy criterion | Primary metric versus the named baseline arm, after realistic costs, with block-bootstrap interval | Passes as written in the charter; interval excludes zero |
| LLM ablation | Paired C1 minus B1 on prospective, timestamp-locked observations only | Passes the charter's preregistered test; otherwise the LLM arm is excluded from production |
| Robustness | Sign of primary metric across periods, regimes, 2x cost stress, and delay stress | Unchanged |
| Concentration | Share of excess return from top security, sector, year, episode | Below the charter's limits |
| Drawdown and turnover | Maximum drawdown and annual turnover | Within charter limits |
| Forward observations | Count of independent prospective decisions | At or above the charter minimum |
| Tax scenario | After-tax result under declared scenarios | Reported; a strategy whose edge disappears in the taxable scenario is flagged |
| Baseline comparison | Result against B0 and against the simpler deterministic variant | Candidate must beat the simpler variant after costs or is not promoted |

Minimum durations and observation counts live in the charter, not here, because they depend on decision cadence and statistical power. An event strategy with a few dozen events per year needs years of shadow, not weeks.

## 4. `LIVE_PROMOTION.md` checklist

A strategy version enters `LIVE_MANUAL` only after an owner-approved `LIVE_PROMOTION.md` exists in the strategy directory. Its required sections:

1. Strategy ID, charter version, and the exact experiment IDs whose results support promotion.
2. Operational scorecard, filled, with links to the CI run, drill logs, reconciliation reports, and incident register.
3. Investment scorecard, filled, with the prospective observation count and the paired ablation result if an LLM arm is included.
4. Evidence tier statement: which conclusions rest on historical, holdout, shadow, or paper evidence, and an explicit line stating that micro-live will calibrate execution and not returns.
5. Broker capability document reference and date, with unverified claims listed.
6. Sleeve account identification: the account hash and confirmation that exactly one account carries role `blackgold_sleeve`.
7. Caps proposed for the authorization: NAV, gross exposure, position size, order size, daily orders, cumulative loss.
8. Halt and recovery runbook references and the date each drill was last run.
9. Restricted-theme confirmation: the compliance policy hash in force and confirmation that no instrument in the authorized set falls under a restricted theme.
10. Reasons the strategy may still not work, written by the reviewer.
11. Owner approval line with date.

## 5. `LIVE_AUTHORIZATION.yaml`

Owner-created, time-limited, and matched field-by-field at startup and before every order. The artifact is signed with an owner key held outside the container; the core verifies the signature and then compares every field against the running system.

```yaml
authorization_id: AUTH-2027-0002
issued_at_utc: 2027-03-02T14:00:00Z
starts_at_utc:  2027-03-03T13:30:00Z
expires_at_utc: 2027-04-03T20:00:00Z          # hard expiry; no grace period

sleeve:
  account_hash: sha256:7d4e...                # exact hash of the single blackgold_sleeve account identifier
  broker: <broker-id>

mode: LIVE_MANUAL                             # or LIVE_LIMITED
approval_mode: per_order                      # per_order for LIVE_MANUAL; version_level for LIVE_LIMITED

allowed:
  charter_versions:
    - { strategy_id: etf_trend_volctl, charter_version: 1.2.0, charter_hash: sha256:9c1f... }
  strategy_versions:
    - { strategy_id: etf_trend_volctl, rules_version: 2, portfolio_version: 1 }
  arms_in_production: [B1_DETERMINISTIC]     # C1 only if the paired prospective ablation passed
  instruments: [VTI, VXUS, IEF, SHV]          # explicit list; no wildcards
  directions: [BUY_TO_OPEN, SELL_TO_CLOSE]   # long-only; no SELL_SHORT, no BUY_TO_COVER
  sessions: [REGULAR]                         # no PRE, no POST
  order_types: [LIMIT_DAY]                    # market and GTC excluded unless listed

caps:
  max_sleeve_nav_usd: 5000
  max_gross_exposure_pct_nav: 100
  max_position_pct_nav: 35
  max_order_notional_usd: 1500
  max_orders_per_session_day: 4
  max_cumulative_loss_usd: 400                # measured from starts_at_utc NAV; breach forces HALT_NEW_RISK

hashes:
  risk_yaml: sha256:2b91...
  compliance_policy: sha256:c4a7...
  executable_version: sha-1f0e9d3c7a2b        # GHCR image tag or binary hash
  model_config: sha256:0000...                # required when any LLM arm is in production; else null

signature:
  key_id: owner-2027
  value: <detached signature over all fields above>
```

### 5.1 Fail-closed matching rule

Before any live-mode action the core evaluates, in order:

1. Signature valid against the configured owner key.
2. Current UTC time within `[starts_at_utc, expires_at_utc)`.
3. Running mode equals `mode`.
4. Sleeve account hash equals `sleeve.account_hash`, and exactly one account carries role `blackgold_sleeve`.
5. Every hash in `hashes` equals the hash of the corresponding running artifact.
6. The proposed order's strategy, charter, arm, instrument, direction, session, and order type are each present in the corresponding `allowed` list.
7. The proposed order keeps every value in `caps` within limit after the order.

Any check that fails, cannot be computed, or times out yields the same result: the order is not formed, the mode transitions to `HALT_NEW_RISK`, and an incident is opened. There is no partial match, no warning-and-continue, and no override flag. An expired authorization is treated identically to a missing one.

The gateway performs checks 2 through 7 independently as a second risk check. Both processes must pass for an order to leave the host.

## 6. What invalidates an authorization

An authorization is invalidated, and the system demotes per Section 8, when any of the following changes without a new authorization:

- model provider, model ID, prompt, output schema, tool set, or decoding settings for any arm in production
- any data transformation, feature definition, or preprocessor version
- strategy rule version
- portfolio construction or sizing rule
- risk policy (`risk.yaml`)
- compliance policy, including the restricted-theme list
- broker adapter or gateway version
- executable version, unless the release is documented as non-behavioral

The non-behavioral exception is narrow: the change must be demonstrably free of any effect on decisions, orders, or risk checks, and a written note citing the diff must be filed before the change is deployed. A dependency bump that touches order formation is behavioral. When in doubt it is behavioral.

Every change also re-scopes the evidence. A new strategy or portfolio rule returns the strategy to rung 1. A new model or prompt returns any LLM arm to rung 2 because its prospective observations no longer describe the running system. A new broker adapter returns to rung 4.

## 7. Halt states

The halt state is a second enum, orthogonal to mode. It constrains what the current mode may do.

| State | New risk-increasing orders | Risk-reducing orders | Position changes without approval | Meaning |
|---|---|---|---|---|
| `NORMAL` | Allowed per mode and authorization | Allowed | Per mode | Steady state |
| `HALT_NEW_RISK` | Blocked | Allowed with normal approval | None | Something is wrong or uncertain; do not add exposure. Default landing state for most faults |
| `HOLD_ONLY` | Blocked | Blocked, except explicitly owner-approved closes | None | Reconciliation or order-state uncertainty; do not touch anything until the picture is reconciled |
| `EMERGENCY_FLATTEN_AUTHORIZED` | Blocked | Owner has pre-authorized the system to close sleeve positions without further per-order approval, within the authorization's caps and order types | Closes only | Reached only by explicit owner action |

Automatic flatten is not a default. No fault, breach, or incident causes the system to enter `EMERGENCY_FLATTEN_AUTHORIZED` on its own. Faults land in `HALT_NEW_RISK` or `HOLD_ONLY`. Flattening a portfolio is itself a trading decision with cost and tax consequences, and a system in an uncertain state is the least qualified party to make it. The owner enters `EMERGENCY_FLATTEN_AUTHORIZED` deliberately, and the state expires automatically at the end of the session in which it was entered.

Transitions between halt states are logged to the event ledger with cause, actor, and timestamp. Transitions toward more restrictive states may be automatic. Transitions toward less restrictive states require an owner action recorded in the ledger.

## 8. Automatic demotion triggers

The system demotes on its own. It never promotes on its own.

| Trigger | Halt state | Mode after demotion |
|---|---|---|
| Authorization expired or fails any matching check | `HALT_NEW_RISK` | `PAPER` (positions remain; no new live orders can form) |
| Unapproved version change detected (any item in Section 6) | `HALT_NEW_RISK` | `SHADOW` for the changed strategy version |
| Risk breach (`caps` or `risk.yaml` limit) | `HALT_NEW_RISK` | Unchanged mode; new risk blocked until owner review |
| Cumulative loss cap reached | `HALT_NEW_RISK` | Unchanged mode; authorization treated as spent |
| Severe incident opened | `HALT_NEW_RISK` or `HOLD_ONLY` per incident class | Unchanged until owner triage |
| Reconciliation break unresolved past one session | `HOLD_ONLY` | Unchanged |
| Uncertain order submission (sent, no acknowledgement) | `HOLD_ONLY` | Unchanged until order state is resolved |
| Repeated data failure (freshness below threshold two consecutive sessions) | `HALT_NEW_RISK` | Unchanged |
| Repeated model failure (LLM arm abstaining or invalid above charter rate) | `HALT_NEW_RISK` for the LLM arm; B1 continues if independently authorized | LLM arm to `SHADOW` |
| Material drift (feature or signal distribution outside charter monitoring bands) | `HALT_NEW_RISK` | `SHADOW` pending review |
| Broken cost calibration (realized shortfall outside charter tolerance over the rolling window) | `HALT_NEW_RISK` | `PAPER` until recalibrated |
| Core and gateway disagree on mode or halt state | `HOLD_ONLY` | More restrictive of the two |

Demotion notifications go to the owner through the notification channel with the trigger, the evidence, and the runbook reference.

## 9. Manual recovery and re-arm

Recovery is always a human procedure. These are runbook-level outlines; the phase that builds the gateway completes them with exact commands.

### 9.1 From `HALT_NEW_RISK`

1. Read the incident and the ledger events that caused the transition.
2. Confirm the root cause is understood and fixed, or that the trigger was a scheduled expiry.
3. Run the health command; confirm reconciliation is clean and every open position has its protection state.
4. If the cause was a version change, decide whether the change is behavioral. If it is, the strategy version re-enters the ladder at the rung Section 6 specifies; there is no re-arm.
5. If the cause was expiry or a non-behavioral change, issue a new `LIVE_AUTHORIZATION.yaml` with updated hashes and expiry.
6. Owner transitions halt state to `NORMAL` through the CLI; the transition is logged with the incident ID.

### 9.2 From `HOLD_ONLY`

1. Resolve the order-state or reconciliation uncertainty against the broker application directly. Do not rely on the gateway's view alone.
2. Record every discrepancy and its resolution in the incident.
3. Re-run reconciliation until it is clean.
4. Transition to `HALT_NEW_RISK`, then follow 9.1.

### 9.3 From `EMERGENCY_FLATTEN_AUTHORIZED`

1. Verify in the broker application that every close was filled and the sleeve holds only cash.
2. Reconcile and record realized results, fees, and tax-lot closures.
3. The state expires at session end. The mode drops to `PAPER`. Re-entering a live mode requires a fresh `LIVE_PROMOTION.md` review, since a flatten implies the strategy or the system is in question.

### 9.4 Re-arm checklist

Before any owner transition toward a less restrictive state:

- health command green
- reconciliation clean at the last close
- no open high-severity incident
- authorization present, signed, in window, all hashes matching
- protection coverage 100%
- the demotion trigger's underlying cause documented as resolved
- if a drill has not run in the scorecard's window, run it first

## 10. What this document does not promise

- It does not promise that any strategy reaches `LIVE_MANUAL`. The valid outcome of the ladder is frequently a stop at rung 1 or 2 with a recorded negative result.
- It does not treat `LIVE_LIMITED` as the goal. It is an optional rung requiring a new written decision.
- It does not define rung 7. Broader automation, if ever considered, gets its own decision document.
- It does not allow any evidence from micro-live to be reported as return evidence. Micro-live calibrates execution and the human workflow.
