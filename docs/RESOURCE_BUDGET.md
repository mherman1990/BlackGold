# Black Gold Resource Budget

Status: Discovery draft. Every number in this document is PROPOSED pending measurement on the actual Raspberry Pi in Phase 0. Numbers become budgets, and CI or runtime alerts are wired to them, only after the Phase 0 benchmark plan in section 9 has been executed and the results recorded in `STATE.md`.

Host assumptions: Raspberry Pi 5, 8 GB RAM, NVMe boot and data drive, umbrelOS, running alongside other Umbrel apps. Black Gold must leave headroom for umbrelOS, Docker, and the other apps. Nothing here assumes Black Gold is the only tenant.

Cross-references: `docs/PRODUCT_SPEC.md` section 12 (reliability requirements), `docs/THREAT_MODEL.md` (storage pressure and availability threats).

## 1. Memory

| Container | Steady (PROPOSED) | Peak (PROPOSED) | Notes |
|---|---|---|---|
| `core` (`blackgold-trading_core_1`) | at most 600 MB | at most 1.2 GB | Peak occurs during backtest, feature snapshot rebuild, or bulk filing parse. Node heap capped with `--max-old-space-size` at 1024 MB. |
| `gateway` (`blackgold-trading_gateway_1`) | at most 150 MB | at most 250 MB | Small process; anything above steady is a leak signal. |
| `app_proxy` | Umbrel-managed | Umbrel-managed | Not counted toward the app budget, but observed. |
| Whole app | at most 1.5 GB | at most 1.5 GB hard | Docker `mem_limit` set per service so the sum cannot exceed 1.5 GB. |

Rationale: 1.5 GB is under 20% of an 8 GB Pi, leaving room for umbrelOS (roughly 1 GB observed on comparable installs, to be measured), Docker overhead, page cache for SQLite and NVMe, and other apps. If Phase 0 measurement shows umbrelOS plus other apps consume more than 4 GB at rest, the whole-app cap is revisited downward, not upward.

Swap use by Black Gold containers is PROPOSED at zero during normal operation. Any swap activity attributable to `core` during a research window is a budget breach.

## 2. CPU

The Pi 5 has 4 cores. Budgets are expressed as a fraction of one core averaged over the stated window, as reported by `docker stats`.

| Window | Average (PROPOSED) | Burst (PROPOSED) | Duration cap |
|---|---|---|---|
| Outside research windows (idle, watchdog, reconciliation) | at most 0.10 core | at most 0.5 core | Burst at most 60 seconds |
| Inside scheduled research window (ingest, candidates, Analyst, portfolio) | at most 1.0 core | at most 2.0 cores | Burst at most 15 minutes per job |
| Backtest or walk-forward run (`BACKTEST` mode, on demand) | at most 2.0 cores | at most 3.0 cores | Must yield if temperature limit in section 5 is reached |
| `gateway` at all times | at most 0.05 core | at most 0.25 core | Burst at most 10 seconds |

Docker `cpus` limits: `core` 3.0, `gateway` 0.5. Research jobs run at reduced scheduling priority (`nice`) inside the container so the gateway, reconciler, and Umbrel itself are never starved.

## 3. Disk

Persistent data lives under `${APP_DATA_DIR}/data`: SQLite at `blackgold.sqlite` and raw artifacts at `artifacts/`.

### Growth assumptions (PROPOSED)

| Track | Daily | Monthly | Assumption |
|---|---|---|---|
| ETF trend/momentum baseline | under 0.2 MB | a few MB | Daily bars for roughly 50 to 100 ETFs plus FRED vintages and COT weekly rows. Almost all in SQLite. |
| Form 4 purchase events | 2 to 10 MB | 60 to 300 MB | Raw Form 4 XML archived for the candidate universe only, not the whole EDGAR feed. Heavy days cluster around earnings seasons. |
| Filing-change challenger | 5 to 20 MB | 150 to 600 MB | 10-K and 10-Q full text plus prior-filing comparables for a bounded universe. This is the dominant consumer. |
| LLM archive (packets, outputs, metadata) | under 1 MB | under 30 MB | Redacted packets and JSON outputs; compressed. |
| Event log and order ledger | under 0.5 MB | under 15 MB | Append-only; never pruned. |
| Logs (rotated) | under 5 MB | under 150 MB | Rotated at 50 MB per file, keep 3. |

Combined worst case with all three tracks active: roughly 1 GB per month. ETF-only operation: under 50 MB per month.

### Caps and thresholds (PROPOSED)

| Control | Value |
|---|---|
| Raw artifact cap | 12 GB for `artifacts/` |
| Minimum free space on the data volume | 15 GB or 10% of the volume, whichever is larger |
| Warning threshold | Free space under 25 GB or under 15% |

Behavior at the minimum free-space threshold:

- Bulk ingestion (filings, Form 4 fetch, feature rebuilds) halts and an incident is raised.
- New LLM analysis stops because it depends on fresh evidence packets.
- Audit writes, order-ledger writes, event-log writes, reconciliation, and risk management continue. These are never blocked by disk pressure short of physical exhaustion.
- Audit and order records are never deleted to free space. Only rotated logs, superseded feature snapshots, and raw artifacts already hash-verified in the off-device backup are candidates for pruning, and pruning is a logged owner action.

## 4. Database

| Metric | Target (PROPOSED) |
|---|---|
| SQLite file size at 12 months, all tracks | under 4 GB |
| Point read (single row by key) | p99 under 5 ms |
| Order-ledger append (single transaction, fsync) | p99 under 25 ms |
| Reconciliation query set (positions plus open orders plus last 500 events) | p99 under 200 ms |
| Daily feature snapshot write for the ETF universe | under 30 seconds |
| WAL checkpoint | under 5 seconds; forced checkpoint nightly after close |
| `PRAGMA integrity_check` | under 10 minutes at 4 GB; weekly |
| Online backup of a 4 GB database to local NVMe | under 10 minutes |
| Encrypted off-device copy of that backup | under 30 minutes on a residential uplink |
| `VACUUM` | Quarterly, in a maintenance window, only after a verified backup |

WAL mode, single writer, `synchronous=FULL` for the ledger connection, `NORMAL` acceptable for research-only tables. Money, price, and quantity stored as integer minor units or decimal strings, never binary float.

## 5. Temperature and throttling

| Metric | Limit (PROPOSED) |
|---|---|
| SoC temperature during idle | under 60 C |
| SoC temperature during research or backtest | under 75 C sustained, under 80 C peak |
| Throttle flags (`vcgencmd get_throttled`) | Zero occurrences during a trading session |

If temperature exceeds 75 C for more than 5 minutes, backtest jobs pause and research jobs reduce parallelism. If any throttle flag is observed during a session, an incident is logged. Throttling does not affect risk or reconciliation correctness, only latency, but it is a signal that the Pi needs a better case, fan, or fewer co-tenant apps. An active cooler is assumed.

## 6. Job deadlines

All deadlines are relative to the exchange calendar session, not wall-clock. Times are budgets for job completion measured from the trigger.

| Job | Trigger | Deadline (PROPOSED) |
|---|---|---|
| Startup reconciliation | Container start | 2 minutes |
| Pre-open data freshness check | 60 minutes before session open | 10 minutes |
| Pre-order reconciliation | Before any order intent | 30 seconds |
| Intraday watchdog reconciliation | Every 15 minutes during session | 30 seconds |
| Around-close reconciliation | Session close | 5 minutes |
| Post-close decision job (ingest, candidates, Analyst, portfolio, compliance, risk) | Session close | 90 minutes; candidates not assessed by the deadline abstain |
| Post-close reconciliation and NAV | After decision job | 10 minutes |
| Daily event-log seal and backup | 22:00 America/Chicago | 45 minutes |
| Weekly report | Saturday 06:00 America/Chicago | 30 minutes |
| Batch LLM work (non-time-critical only) | Weekend or after post-close job | Up to 24 hours per the verified batch window; results consumed next post-close job |

A missed deadline raises a missed-run alert and, for any job that gates new risk, leaves the system in `HALT_NEW_RISK` until the job completes or Matt re-arms.

## 7. LLM spend

All figures are configurable in the capability manifest and all are PROPOSED.

| Scope | Cap |
|---|---|
| Per candidate assessment (single Analyst call including retries) | at most $0.50 |
| Per post-close decision job | at most $3.00 |
| Per day | at most $5.00 |
| Per month | at most $60.00 |
| Per registered experiment using the premium tier | Separate, explicitly approved budget in the experiment registration |

Degradation rule: when any cap is reached, new analysis is skipped and affected candidates record `abstain: true` with `abstainReason` set to the budget code. Risk management, reconciliation, existing protective orders, and reporting continue without interruption. A budget breach is never a reason to suspend safety functions.

Batch processing at the 50% discount is used only for work that can tolerate the 24-hour window, for example weekend re-extraction of filing ontologies. Market-timed assessments run synchronously against the post-close deadline.

## 8. Recovery objectives

| Asset | RPO (PROPOSED) | RTO (PROPOSED) | Mechanism |
|---|---|---|---|
| Order ledger and event log | 0 for local NVMe (fsync per transaction); 24 hours for off-device | 30 minutes to restore locally, 4 hours from off-device | WAL with `synchronous=FULL`; nightly online backup; encrypted off-device copy with sealed daily root hash |
| Raw evidence artifacts | 24 hours | 24 hours | Nightly rsync-style encrypted off-device copy; re-fetchable from public sources where the source still serves them |
| Configuration (`risk.yaml`, restricted lists, capability manifest, financial-picture schema) | 0 | 1 hour | Versioned in git (templates) plus encrypted local store for sensitive values, backed up nightly |
| Secrets (broker tokens, model API keys) | Not backed up off-device | 2 hours (manual reauthorization) | Documented key custody; re-issue rather than restore |

After any restore, the system starts in `HALT_NEW_RISK`, runs full reconciliation against the broker, and requires manual re-arm. Restore drills run quarterly against a scratch data directory and their durations are recorded against the RTO figures above.

## 9. Phase 0 benchmark plan

Run on the actual Pi 5 with umbrelOS and the other intended co-tenant apps installed and idle. Record results in `STATE.md` with date and umbrelOS version. Repeat after any hardware, OS, or major dependency change.

| Measurement | How | Pass condition |
|---|---|---|
| Baseline host memory and CPU with Black Gold stopped | `free -m`, `docker stats --no-stream`, `top -bn1` sampled every 60 s for 30 minutes | Establishes headroom; if under 3 GB free, revisit section 1 |
| `core` and `gateway` steady RAM and CPU | `docker stats --no-stream` every 30 s over a full simulated session in `SHADOW` mode | Within section 1 and 2 steady figures |
| `core` peak RAM and CPU during a backtest | `docker stats` at 5 s cadence during a full ETF walk-forward run | Within section 1 and 2 peak figures |
| Disk growth per track | `du -sh ${APP_DATA_DIR}/data/artifacts` and SQLite file size daily for 14 days with each track enabled in turn | Within section 3 daily figures scaled to 14 days |
| SQLite latency | Timed harness executing 10,000 point reads, 1,000 ledger appends with fsync, and 100 reconciliation query sets; report p50, p99 | Within section 4 targets |
| Integrity check and backup duration | `time sqlite3 blackgold.sqlite "PRAGMA integrity_check"` and timed `.backup` on a synthetic 4 GB database | Within section 4 targets |
| Temperature and throttling | `vcgencmd measure_temp` and `vcgencmd get_throttled` every 10 s during idle, research window, and backtest | Within section 5 limits |
| Job durations | Job scheduler records start, end, and deadline for every job over 10 simulated sessions | Every job within section 6 deadlines |
| LLM cost per assessment | Archive of token usage and cost for 50 synthetic candidate packets against the pinned model | Within section 7 per-call cap; record actual prompt-cache hit rate |
| Backup and restore | Timed nightly backup, timed encrypted off-device copy, timed restore to scratch directory followed by `integrity_check` | Within section 4 and 8 targets |
| Power-loss recovery | Pull power during an active WAL write on a scratch database; restart; run `integrity_check` and reconciliation | Database recovers or restores from last backup; system comes up in `HALT_NEW_RISK` |
| Full-disk behavior | Fill the data volume to the minimum free-space threshold with a dummy file; run a session | Bulk ingestion halts; audit and ledger writes succeed; incident raised |

Any measurement that fails its pass condition becomes a blocker recorded in `STATE.md`. Budgets are then either met by engineering changes or revised with an ADR explaining why the number moved.
