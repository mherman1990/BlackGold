# Black Gold Threat Model

Status: Discovery Pack draft, 2026-09-06. Owner: Matt Herman. Review cadence: before each phase PR is opened, and after any incident.

This document identifies what Black Gold must protect, who and what can act against it, and which controls close each threat. It is written for an expert operator who will also be the only user. The point of the exercise is not completeness for its own sake; it is to separate threats that are closed by enforcement from threats that are only addressed by guidance, and to be honest about residual risk while a Raspberry Pi runs unattended with a broker credential on it.

Related documents: `docs/DATA_PROVENANCE_SPEC.md` (point-in-time data contract, temporal leakage), `docs/CONTEXT_PROVENANCE.md` (context-use firewall), `docs/CAPABILITY_REGISTER.md` (broker capability hypotheses), `docs/schwab-api-capabilities.md` and `docs/alpaca-api-capabilities.md` (to be produced in Phase 6 and Phase 5 respectively; every Schwab claim below is UNVERIFIED until they exist), `docs/RESOURCE_BUDGET.md`, `docs/AUTOMATION_AND_LIVE_GATES.md`.

## 1. Assets

Ranked by consequence of loss, not by likelihood of attack.

| # | Asset | Where it lives | Consequence of compromise |
|---|---|---|---|
| A1 | Sleeve capital (the one `blackgold_sleeve` account) | Broker | Direct financial loss, bounded by sleeve size and hard caps only if the caps hold |
| A2 | Broker credential (Schwab OAuth refresh/access token; Alpaca paper key) | `blackgold-broker-gateway` container only; Docker secret or encrypted local store | Anyone holding it has whatever the broker grants that token. UNVERIFIED whether a Schwab token is scoped to one account or to every account under Matt's login; assume the latter until the Phase 6 capability register proves otherwise |
| A3 | Household financial picture (non-sleeve balances, liquidity needs, career exposure flags, restricted list rationale) | `${APP_DATA_DIR}/data/blackgold.sqlite`, schema-validated local config | Privacy loss; if it reaches the model or a report leaving the device, it also breaks the professional-information firewall |
| A4 | Restricted list and compliance policy (names, themes, blackout windows, version hash) | SQLite plus committed policy template | Tampering or stale state lets the sleeve take exposure Matt is prohibited or reputationally unable to hold |
| A5 | Event ledger (append-only, hash-chained decision, order, and reconciliation events) | SQLite WAL; daily sealed root hash copied off-device | Loss destroys the audit trail and the counterfactual experiment record; tampering hides a bad trade or a rule bypass |
| A6 | Model provider API key and inference budget | `blackgold-core` container secret | Cost abuse; more importantly a leaked key with logging enabled could expose evidence packets to a third party |
| A7 | Research evidence and raw artifacts | `${APP_DATA_DIR}/data/artifacts/` | Loss is recoverable from public sources at a cost; tampering can poison backtests |
| A8 | Release chain: `mherman1990/BlackGold` repo, GitHub Actions, `ghcr.io/mherman1990/blackgold` images, the one-app Umbrel Community App Store | GitHub and GHCR | Whoever controls the chain controls the code that holds A2 on the Pi |
| A9 | `LIVE_AUTHORIZATION` artifact and mode configuration | Signed file on the Pi, referenced by the gateway | Forging or extending it turns a shadow system into a live one without Matt's consent |
| A10 | Matt's professional standing at ISA | Not on the device | A single trade that looks informed by nonpublic professional knowledge is a career and legal problem regardless of P&L |

## 2. Actors and trust boundaries

### Components and what each is trusted to do

| Component | Trusted with | Explicitly not trusted with |
|---|---|---|
| `blackgold-core` | Research, strategy, portfolio construction, compliance/risk, approvals, reporting, model calls, public-data ingestion | Any live broker credential; any order submission; any non-sleeve mutation |
| `blackgold-broker-gateway` | The single broker credential; revalidating and submitting a signed `OrderIntent`; read-only account queries | Forming intents; inferring the account; proxying arbitrary broker paths or raw order JSON |
| Broker (Schwab live, Alpaca paper) | Custody, execution, protective orders as one layer | Enforcing our account isolation (a token may reach more than the sleeve) |
| Model provider (behind `ModelAdapter`) | Bounded extraction and synthesis over sealed evidence packets | Anything executable: no size, no side, no order, no tool with side effects |
| Public data sources (EDGAR, FRED, CFTC, Treasury, BLS, BEA, market data) | Nothing. All content is untrusted data | Instructions of any kind |
| GitHub Actions | Building, testing, scanning, and publishing images from reviewed commits | Holding production credentials of any kind |
| Pi / umbrelOS host | Running both containers, holding Docker secrets, local backups | Being physically secure; being free of other apps with local network access |
| Matt's workstation | Authoring code, approving PRs, approving trades, holding the GitHub session | Being uncompromised; being the only path to `main` |
| Matt as operator | All approvals, restriction removals, live authorization | Being awake, unhurried, and error-free at 14:45 CT |

### Trust boundaries

1. `blackgold-core` to `blackgold-broker-gateway`: a local, authenticated channel carrying only a signed `OrderIntent` or a read query. This is the most important boundary in the system because it is the only one we fully control.
2. `blackgold-broker-gateway` to broker: TLS to the official API only. No scraping, no unofficial libraries.
3. `blackgold-core` to model provider: outbound only, evidence packets redacted, responses schema-validated.
4. Public internet to `blackgold-core`: inbound is zero by default. Admin UI binds to Umbrel-local only, behind `app_proxy`.
5. GitHub to Pi: only via a pinned image digest that Matt updates deliberately. No auto-update.
6. ISA professional environment to Black Gold: no connector exists. This boundary is enforced by absence, not by a filter.

### Data flows across boundaries

Every flow that crosses a trust boundary is enumerated here. A flow not in this table should not exist; finding one in code is a review finding.

| Flow | From | To | Payload | Validation at the receiving side |
|---|---|---|---|---|
| F1 | Public data sources | `blackgold-core` | Raw HTTP bodies (JSON, XBRL, HTML, CSV) | Host on egress allowlist; response hashed and stored as an untrusted artifact before parsing; adapter schema; size cap per source |
| F2 | `blackgold-core` | Model provider | Sealed, redacted evidence packet; pinned model ID and prompt version | Packet type refuses to serialize with dollar totals, account hashes, or secret patterns; token and cost budget check |
| F3 | Model provider | `blackgold-core` | `ResearchAssessment` JSON | Strict schema; citation verification against the packet; no numeric field is read by sizing; abstain on failure |
| F4 | `blackgold-core` | `blackgold-broker-gateway` | Signed `OrderIntent` with explicit sleeve account hash, strategy version, risk snapshot reference, quote timestamp and source, client-order ID; or a read query | Signature; mode; `LIVE_AUTHORIZATION` validity; account allowlist; instrument allowlist; side long-only; quantity and notional caps; quote freshness; duplicate client ID rejection |
| F5 | `blackgold-broker-gateway` | Broker | Order submission, cancel, order status, positions, balances on allowlisted endpoints only | TLS to official host; no arbitrary path; response schema; correlation to persisted intent |
| F6 | Broker | `blackgold-broker-gateway` | Order events, fills, account state | Idempotent event processing; out-of-order tolerance; reconciliation against ledger |
| F7 | `blackgold-broker-gateway` | `blackgold-core` | Order state transitions and read-only account views | Read-only types with no mutation methods; every transition appended to the ledger |
| F8 | `blackgold-core` | Notification provider | Alerts and daily report summaries | Redaction; IDs not payloads; treated as public once sent |
| F9 | Matt's workstation | GitHub | Commits, PR approvals, tag signatures | Branch protection; required CI; hardware 2FA recommended |
| F10 | GitHub Actions | GHCR | Container images tagged `vX.Y.Z` and `sha-<12hex>` | Tag-gated publish workflow from `main` only; digest recorded in manifest by Matt |
| F11 | GHCR | Pi | Image pull on deliberate manifest update | Digest pinned in the Umbrel manifest; no auto-update |
| F12 | Matt on the LAN | Umbrel-local UI | Trade approvals, restriction changes, halt clears, emergency flatten command | Authentication, CSRF protection, secure cookies, authorization; flatten requires separate authentication; changes are versioned and logged |
| F13 | Matt's other brokerage exports | `blackgold-core` | CSV or read-only API imports of non-sleeve accounts | Read-only types; stored encrypted; never reaches F2 or F8 in dollar form |

### Broker credential lifecycle

| Stage | Handling | Threats addressed |
|---|---|---|
| Issue | OAuth consent performed by Matt on the workstation; refresh token delivered to the Pi through a one-time encrypted channel, never through git, chat, or email | T-21 |
| Store | Docker secret or encrypted local store readable only by the gateway container's user; key custody documented in the runbook | T-02, T-16 |
| Use | Gateway exchanges refresh for access tokens in memory; access token never logged or persisted beyond its lifetime; every use is an audit event | T-21 |
| Rotate | Refresh on the schedule the capability register documents (UNVERIFIED for Schwab); failure to refresh sets `HALT_NEW_RISK` and notifies | T-09 |
| Revoke | Runbook step executable from Matt's phone via the broker's own application; Black Gold detects revocation as auth failure and halts new risk while continuing read-only reconciliation if any credential remains valid | T-02, T-16, T-23 |

## 3. Threat register

Likelihood and impact are qualitative (Low / Med / High). "Closes" names the phase whose exit criteria make the mitigation a tested gate; "Residual" is what remains after that phase.

### 3.1 Credential and account isolation

| ID | Threat | Entry point | Impact | Likelihood | Mitigations | Residual | Closes |
|---|---|---|---|---|---|---|---|
| T-01 | Schwab token reaches every household account, not just the sleeve. A bug or attacker in the gateway can trade, or worse, in an IRA or spouse account | Gateway process; any code with gateway credential access | High: household-wide loss | Med (UNVERIFIED scoping) | Gateway account allowlist keyed to the `blackgold_sleeve` account hash; second independent risk check in gateway; `OrderIntent` carries the account supplied by trusted code and the gateway rejects any other; non-sleeve interfaces are types with no mutation methods (CI gate); no transfer, journal, beneficiary, or profile endpoints exist in code; capability register must document actual token scope before any live call | Code separation is not broker-enforced permission. If the token is household-wide, a gateway RCE still reaches everything. Matt must explicitly accept this blast radius in Phase 6 or choose a broker/account structure that scopes it | Phase 6 (documented and accepted), never fully closed |
| T-02 | Token theft from the Pi (disk image, container escape, another Umbrel app on the same host) | Physical access; malicious or vulnerable co-tenant app; Docker socket exposure | High | Low to Med | Docker secrets or encrypted store with documented key custody; gateway runs as non-root with read-only filesystem; no Docker socket mount; short-lived access tokens, refresh token stored encrypted; revoke-on-suspicion runbook; no public exposure | While the Pi runs unattended the decrypting key is in memory or on disk. State this candidly in the runbook. Full-disk encryption on umbrelOS is not assumed | Phase 6 |
| T-03 | Forged or extended `LIVE_AUTHORIZATION` enables live mode | Config tampering; a "just set the env var" shortcut | High | Low | Live paths absent by construction through Phase 5; from Phase 6 the artifact is signed, capital-capped, tied to an exact strategy/model/prompt/data/risk version hash, and expires automatically; a single environment variable cannot enable live; gateway verifies the artifact independently of core | Matt can still sign a bad authorization. The cooling period and `LIVE_PROMOTION.md` are guidance for that | Phase 7 |

### 3.2 Model and research surface

| ID | Threat | Entry point | Impact | Likelihood | Mitigations | Residual | Closes |
|---|---|---|---|---|---|---|---|
| T-04 | Prompt injection via a filing, press release, or fetched webpage steers the model | Any ingested document | Med if bounded, High if the model had tools | High (attempted); Low (successful) | Research models receive no shell, filesystem-write, network, secret, config, or broker tools; source text is delimited and sanitized; output is a strict `ResearchAssessment` schema with citations verified against the sealed evidence packet; deterministic code owns every number; adversarial fixture corpus in CI; abstention on schema failure | An injected document can still bias a bounded assessment. Ablation arms (B1 vs C1) are how we detect that the overlay is net harmful | Phase 3 |
| T-05 | Model output treated as an order or a size | Developer convenience; a future "let the agent decide" refactor | High | Med (drift risk over time) | Type-level separation: `ResearchAssessment` has no fields the sizing engine reads; sizing takes only deterministic inputs; property tests assert no LLM field influences quantity; CI policy test greps for forbidden imports across the boundary | None if the CI gate survives. The gate itself is protected by branch protection | Phase 4 |
| T-06 | MNPI or professional information leaks into signals | Matt copying an internal brief into a prompt or fixture; a connector added "for convenience"; a restricted name being relaxed in a hurry | High (A10) | Low to Med | No workplace connectors or paths exist; allowlisted public sources only, each with provenance; restricted names/themes default to no new exposure; additions take effect immediately, removals require a logged owner action, reason, approved policy, and cooling period; audit stores restriction version/hash and rule result; unknown ETF look-through or unknown classification fails closed; egress allowlist blocks non-approved hosts | The system cannot see what Matt knows. If Matt approves a trade in a name they have MNPI on, no code stops that. Counsel-approved policy and the cooling period are the controls, and they are guidance | Phase 4 (mechanics), ongoing (behaviour) |
| T-07 | Model provider outage or 24-hour batch latency at decision time | Provider incident; Message Batches queue | Med | Med | Synchronous calls with deadlines for market-timed work; batch only for non-time-critical research; on timeout the arm abstains and B1 (deterministic) still records; risk and reconciliation never depend on the model | A prolonged outage silently degrades C1 to B1. The ledger records this so the ablation stays honest | Phase 3, Phase 5 |
| T-08 | Silent model or prompt drift changes the signal process | Provider alias update; prompt edit; fallback model | Med | High | Model IDs pinned in config, never hardcoded; prompt and model version hashed into every decision record; any material change is a new strategy version with a new forward record; fallback is logged as a distinct version | Provider-side changes behind a pinned ID are outside our control; contamination labelling on historical results | Phase 3 |

### 3.3 Order integrity and broker failure

| ID | Threat | Entry point | Impact | Likelihood | Mitigations | Residual | Closes |
|---|---|---|---|---|---|---|---|
| T-09 | Broker or API failure leaves an order in `UNKNOWN` state | Timeout, connection loss, 5xx after submit | High if retried blindly (duplicate exposure) | Med | Intent, authorization reference, risk snapshot, quote timestamp, and deterministic client-order ID persisted before the first external side effect; on uncertainty set `UNKNOWN` and query broker by client ID before any retry; never blind-resubmit; `HALT_NEW_RISK` while any order is `UNKNOWN`; fault-injection suite at every network boundary | Broker may not support client-ID lookup (UNVERIFIED for Schwab). If not, reconciliation is by order history and time window, which is weaker | Phase 0 (synthetic), Phase 6 (real fixtures) |
| T-10 | Duplicate order from duplicate job, replayed webhook, reconnect, or reboot | Scheduler; event stream; container restart | High | Med | Every job has a deterministic idempotency key with persisted attempt/status; client-order ID derived from intent hash; gateway rejects a client ID it has already seen; state machine transitions are persisted and legal-transition checked; reboot test in CI | Broker-side idempotency semantics differ; Alpaca auto-generates client IDs if absent, so ours must always be present | Phase 0, Phase 6 |
| T-11 | Protective order fails, is rejected, gaps, or becomes invalid after a corporate action | Broker rejection; partial fill leaving unprotected quantity; split changing quantity | Med to High | Med | Entry is not `PROTECTED` until broker truth confirms coverage of filled quantity; `PROTECTION_FAILED` triggers `HALT_NEW_RISK`, urgent notification, and a preapproved reduction/cancel playbook; position size, no leverage, and diversification remain the primary controls; stops are one layer | Overnight gaps through a stop are not preventable. Documented residual loss scenarios in `risk.yaml` | Phase 6 |
| T-12 | Indiscriminate auto-flatten on a data or accounting error | Bad price feed; reconciliation false positive | High | Low | Default drawdown response is `HALT_NEW_RISK` then `HOLD_ONLY`; `EMERGENCY_FLATTEN_AUTHORIZED` requires a separately authenticated manual command; no automatic path to flatten | A human can still flatten badly under stress. Runbook and a mandatory quote-freshness check before the command | Phase 4 |
| T-13 | Unexpected position or order appears in the sleeve, or ledger diverges from broker | Manual trade in the broker app; broker-side action; bug | Med | Med | Reconcile on startup, before new orders, after each broker event, periodically in session, at exchange close, and after close; any divergence halts new risk; never repair by touching another account | Manual trades by Matt in the sleeve are legitimate but break the experiment record; policy says do not | Phase 5 |

### 3.4 Infrastructure and time

| ID | Threat | Entry point | Impact | Likelihood | Mitigations | Residual | Closes |
|---|---|---|---|---|---|---|---|
| T-14 | Clock drift or wrong timezone causes wrong session timing or accepts a stale quote | Pi RTC absent; NTP blocked; DST edge | Med to High | Med | Exchange calendar, not wall-clock cron; UTC internally, `America/Chicago` at the boundary only; drift check against NTP and against broker/data server timestamps; fail closed for new orders when timestamps are untrustworthy; DST and early-close fixtures | A subtle drift within tolerance still shifts effective decision time by seconds; acceptable for daily-cadence strategies | Phase 0 |
| T-15 | Disk full on the NVMe | Bulk filing download; log growth; WAL not checkpointed | Med | Med | Storage budgets defined before bulk download (see `docs/DATA_PROVENANCE_SPEC.md`); minimum free-space threshold triggers `HALT_NEW_RISK` and stops ingestion, never audit deletion; scheduled checkpoint and vacuum; log rotation; risk and reconciliation must still run with near-zero free space (preallocated ledger headroom) | SQLite write failure during a reconciliation is a hard fault; test it | Phase 0 |
| T-16 | Pi physical or network compromise | Theft; co-tenant Umbrel app; router compromise; exposed port | High | Low | Admin interfaces Umbrel-local only; no public exposure; egress allowlist; non-root containers; secrets as above; daily sealed ledger root hash copied off-device so tampering is evident; revoke tokens on loss | Physical access to an unencrypted NVMe yields everything on it. Encrypt or accept | Phase 6 |
| T-17 | Power loss or SQLite corruption | Pi unplugged mid-write | Med | Med | WAL mode, single writer, online backup API, integrity check on start, scheduled restore drills, RPO/RTO targets for ledger, evidence, and config | Loss of the last seconds of ledger before a seal | Phase 0 |

### 3.5 Supply chain and release pipeline

| ID | Threat | Entry point | Impact | Likelihood | Mitigations | Residual | Closes |
|---|---|---|---|---|---|---|---|
| T-18 | Malicious npm package, base image, or GitHub Action | Dependency update; typosquat; compromised maintainer; unpinned action tag | High (runs beside the credential) | Med | Lockfile with integrity hashes; base images pinned by digest; Actions pinned by commit SHA; SBOM produced per build; dependency and image scanning in CI; minimal dependency policy in `CLAUDE.md`; gateway has the smallest dependency set of any package | A compromised package that passes scanning still ships. Egress allowlist limits exfiltration; gateway network policy allows the broker host only | Phase 0 (pins, SBOM), Phase 6 (gateway egress) |
| T-19 | Malicious image pushed to GHCR, or tag moved | Compromised GitHub session; leaked `GITHUB_TOKEN`; workflow injection via PR | High | Low | Branch protection on `main` with required reviews and CI; release workflow runs only on tags from `main`; images tagged `vX.Y.Z` and `sha-<12hex>`, never `latest`; Umbrel manifest references a digest; release-consistency checker compares manifest, tag, and image; Pi never auto-pulls; Matt updates the manifest deliberately after checking the digest | A compromised Matt GitHub account can approve its own PR unless a second reviewer or hardware key is required. Recommend hardware 2FA and signed tags | Phase 0 |
| T-20 | Workflow secret exfiltration via a pull request | `pull_request_target` misuse; secrets in PR CI | Med | Low | PR CI requires no production credentials at all; publish workflow separated and tag-gated; no long-lived secrets in Actions beyond the GHCR publish token | None significant if PR CI stays credential-free | Phase 0 |

### 3.6 Secrets and information leakage

| ID | Threat | Entry point | Impact | Likelihood | Mitigations | Residual | Closes |
|---|---|---|---|---|---|---|---|
| T-21 | Secret leaks into logs, error telemetry, prompts, git, fixtures, or notifications | Stack trace with a header; debug log of a request; committed `.env`; a notification with a token in a URL | High | Med | Secret scanning in PR CI and pre-commit; structured logging with a redaction layer keyed to known secret patterns and account hashes; prompts built only from sealed, redacted evidence packets; notifications carry IDs, not payloads; `CLAUDE.local.md` gitignored; runtime data never in git | Redaction is pattern-based and can miss a novel format. Off-device notifications are treated as public | Phase 0, Phase 3 |
| T-22 | Household dollar totals or account hashes reach the model or an off-device report | Sloppy packet builder; a "helpful" summary | High (A3, A10) | Med | Schema-level: the packet type has no field for dollar totals; the model may receive sleeve-relative percentages, conservative exposure flags, staleness, and applicable restrictions only; reports leaving the device pass the same redaction; test that a packet containing a dollar total fails to serialize | A percentage plus a known sleeve size reveals a total. Do not put sleeve size in any off-device artifact | Phase 4 |

### 3.7 Insider and operator

| ID | Threat | Entry point | Impact | Likelihood | Mitigations | Residual | Closes |
|---|---|---|---|---|---|---|---|
| T-23 | Matt's workstation is compromised | Malware; stolen laptop; phishing of the GitHub session | High: the workstation can push code, approve PRs, sign `LIVE_AUTHORIZATION`, and approve trades | Low | Branch protection still requires CI to pass, so a malicious change must also defeat the policy tests; hardware 2FA on GitHub; `LIVE_AUTHORIZATION` signing key kept off the daily workstation (hardware token or separate device); trade approvals require the Umbrel-local UI, which is unreachable from outside the LAN; capital cap and expiry bound the damage of a forged authorization | The workstation is on the LAN. An attacker with a persistent foothold can approve trades within the cap. The cap is the control | Phase 7 |
| T-24 | Matt, under time pressure, overrides a restriction or approves a trade that a rule flagged | Operator fatigue; a "just this once" removal | Med to High | Med | Restriction removals require reason, policy reference, and a cooling period that is enforced by code, not by will; blocked trades cannot be approved through the UI, only the rule can be changed and that change is versioned and delayed; halt states are sticky | The cooling period length is a policy choice. Too short and it is decoration | Phase 4 |
| T-25 | Claude Code (the implementation agent) weakens a gate during a phase | A well-meaning refactor that removes a CI test or widens an interface | High | Med | Policy tests live in a protected path with a CODEOWNERS rule; `.claude/rules/` scoped to `packages/gateway/**` and `packages/compliance/**` forbid edits without an explicit owner instruction in the PR; PR template requires a risk note and rollback; Matt merges, the agent does not | Rules are context, not enforcement. The enforcement is branch protection plus a CI job that fails if the policy test count decreases | Phase 0 |

## 4. Attack tree: money leaves the sleeve without a valid decision

```text
Money leaves the sleeve without a valid, authorized decision
├── A live order is submitted in a non-live mode
│   ├── LIVE_AUTHORIZATION forged or expired-but-honoured      -> T-03
│   └── Mode check bypassed in core but not in gateway         -> gateway revalidates independently
├── A valid decision is executed twice
│   ├── Duplicate job or replayed event                         -> T-10
│   └── Retry after UNKNOWN without reconciliation              -> T-09
├── The decision itself is corrupted
│   ├── Injected document biases the model                      -> T-04 (bounded by T-05)
│   ├── Model output becomes size or side                       -> T-05
│   └── Leaked future data makes a backtest look promotable     -> docs/DATA_PROVENANCE_SPEC.md
├── The order is legitimate but unprotected
│   └── Protection fails, gaps, or is invalidated               -> T-11
└── An order reaches a non-sleeve account
    ├── Gateway allowlist bypass                                -> T-01 (residual: token scope)
    └── Credential stolen and used outside Black Gold           -> T-02, T-16, T-23
```

## 5. Detection and response

A mitigation that fails silently is not a mitigation. Each threat class needs a signal that it is happening and a predefined response that does not require improvisation at 14:45 CT.

| Threat class | Detective signal | Where it surfaces | Predefined response |
|---|---|---|---|
| Account isolation (T-01, T-02) | Gateway rejects an `OrderIntent` for an unknown account hash; any read of a non-sleeve account returning an order or position not in the ledger | Gateway audit event; reconciliation report | `HALT_NEW_RISK`; revoke and reissue the broker token; open incident; no automated remediation in any account |
| Live authorization (T-03) | Gateway sees a live-mode intent while `LIVE_AUTHORIZATION` is absent, expired, or hash-mismatched | Gateway audit event; urgent notification | Reject; `HALT_NEW_RISK`; the event itself is a severity-1 incident because it means core and gateway disagree about mode |
| Injection and model misuse (T-04, T-05) | Schema validation failure; citation not found in sealed packet; model requesting a tool that does not exist; unusual token counts | Model call ledger; abstention counter | Abstain for that decision; quarantine the source document hash; add to adversarial corpus |
| Professional firewall (T-06) | Restricted-name match on a candidate; restriction removal inside cooling period; egress to a non-allowlisted host | Compliance rule log; egress denial log | Block; log with restriction version hash; egress denial is an incident because no legitimate path produces it |
| Order integrity (T-09 to T-13) | Any order in `UNKNOWN` for more than the configured reconciliation window; duplicate client ID; fill without matching intent; protection not confirmed within its deadline | Order state machine events; reconciliation diff | `HALT_NEW_RISK`; run reconciliation; follow the protection-failure playbook; never resubmit until broker truth is known |
| Time and host (T-14 to T-17) | NTP offset above tolerance; free space below floor; integrity check failure; unexpected reboot count; Pi throttling flag | Health command; daily ops report | Fail closed for new orders; stop ingestion; restore drill if integrity fails |
| Supply chain and release (T-18 to T-20) | Lockfile changed without a matching PR note; scanner finding above threshold; image digest in manifest not matching a CI-built digest; workflow run on a non-`main` ref attempting publish | PR CI; release-consistency checker; GHCR audit log | Block merge or publish; roll back the manifest to the last verified digest |
| Secret leakage (T-21, T-22) | Secret scanner hit in a commit, log line, or notification; serialization guard triggered on a packet | Pre-commit; CI; runtime guard counter | Rotate the secret; purge the artifact; treat any off-device leak as public |
| Operator and agent (T-23 to T-25) | Policy test count decreased; CODEOWNERS path touched without owner instruction; approval issued outside the LAN | CI; GitHub audit; UI auth log | Block merge; require Matt to re-approve from the Umbrel-local UI |

Notification delivery is itself unreliable (T-07 applies to notification providers too). Every response above is executed by deterministic code first and notified second. Risk and reconciliation never wait for a human acknowledgement.

## 6. Assumptions and out of scope

Assumptions this model depends on. If any becomes false, revisit the register.

1. Matt is the only user and the only approver. There is no multi-user authorization model.
2. The Pi sits on a home LAN behind a consumer router with no port forwarding to Black Gold. umbrelOS may expose other apps; Black Gold does not rely on them.
3. The sleeve is small enough that a total loss is painful but not ruinous. Hard caps in `risk.yaml` encode this; the threat model does not protect against Matt raising them.
4. Broker APIs are used as documented at the time of the capability register. Undocumented behaviour is treated as a fault, not a feature.
5. The model provider does not train on API inputs under the applicable terms. If this changes, the evidence packet redaction rules must be revisited because packets would then be a disclosure path.

Out of scope for this document: market risk of the strategy itself (Alpha Charter), tax outcomes (Phase 4 reporting), and the correctness of the research hypothesis. A perfectly secure system running a strategy with no edge loses money slowly and honestly; that outcome is acceptable and expected to be possible.

## 7. Phase closure summary

| Phase | Threats closed or first gated | Residuals that remain after the phase |
|---|---|---|
| Phase 0 | T-09 and T-10 on the synthetic broker; T-14, T-15, T-17; T-18, T-19, T-20; T-21 (scanning); T-25 | Real broker semantics untested; blast radius unknown |
| Phase 1 | Temporal leakage (see `docs/DATA_PROVENANCE_SPEC.md`) | Survivorship in equity universes |
| Phase 3 | T-04, T-07, T-08; T-21 (prompt redaction) | Biased-but-schema-valid assessments; provider-side drift behind a pinned ID |
| Phase 4 | T-05, T-06 mechanics, T-12, T-22, T-24 | Matt's own knowledge; cooling-period length |
| Phase 5 | T-13; paper-versus-simulator divergence measured | Paper omits impact, latency, fees, dividends |
| Phase 6 | T-01 documented and accepted, T-02, T-09 to T-11 on real fixtures, T-16 | Token scope if household-wide; physical theft of an unencrypted disk |
| Phase 7 | T-03, T-23 | A forged authorization within cap and expiry |
| Phase 8 | No new closures; automation widens exposure to every residual above | All of the above at higher frequency |

## 8. Controls that are enforcement versus guidance

The distinction matters because the spec repeatedly says "never" about things that only a test or a type can actually prevent. Anything in the right-hand column can be undone by a single edit in a single session.

### Enforcement (a machine refuses)

| Control | Mechanism | Protects |
|---|---|---|
| Branch protection on `main` | Required CI status, required review, no force-push, no direct push; signed tags for releases | T-19, T-25 |
| CI policy tests | Test asserting non-sleeve interfaces have no mutation methods; test asserting no import path from `ResearchAssessment` into sizing; test asserting no live code path is reachable before Phase 6; test asserting the policy test count never decreases; secret scan; identifier/version/image consistency check | T-01, T-05, T-03, T-21, T-25 |
| Gateway allowlist | The gateway holds a single account hash and rejects any `OrderIntent` for any other value; no generic HTTP proxy endpoint exists | T-01 |
| Type-level absence of mutation methods | `ReadOnlyAccountView` and `ResearchAssessment` types contain no order, transfer, size, or side fields; the compiler and a CI reflection test enforce it | T-01, T-05, T-22 |
| Expiring, capital-capped `LIVE_AUTHORIZATION` | Signed artifact with version hash and expiry, verified by the gateway independently of core | T-03, T-23 |
| Deterministic idempotency keys and persisted state machine | Intent persisted before side effect; gateway rejects seen client IDs; legal transitions checked | T-09, T-10 |
| Fail-closed halt states | Unknown, stale, conflicting, or unverifiable state sets `HALT_NEW_RISK`; the halt is sticky until a logged clear | T-06, T-13, T-14, T-15 |
| Pinned dependencies, digests, and Action SHAs | Lockfile integrity, image digests, SBOM, scanner failing the build | T-18, T-19 |
| Egress allowlist | Container network policy allowing only model, broker, market-data, notification, and approved public-data hosts | T-04, T-06, T-18 |
| Redaction at serialization | Evidence packet and off-device report types that fail to serialize with a dollar total, account hash, or secret pattern present | T-21, T-22 |
| Cooling period on restriction removal | Eligibility date computed and stored by code; the rule engine will not consider the name before it | T-06, T-24 |

### Guidance only (a person or agent is asked to comply)

| Control | Why it is not enforcement |
|---|---|
| `CLAUDE.md` and `.claude/rules/*.md` | Context for the implementation agent. A new session can miss it or reason around it. Use PreToolUse hooks and CI for anything that must hold |
| Prompts and system instructions to the research model | Untrusted documents are in the same context window. Schema validation and tool absence are the enforcement; the prompt is a request |
| `LIVE_PROMOTION.md`, Alpha Charter, runbooks | Documents Matt reads before signing. They shape a decision; they do not block one |
| "Do not trade manually in the sleeve" | Broker-side policy cannot be set by us |
| "Do not paste professional material into a prompt" | The system cannot inspect Matt's knowledge; counsel-approved policy and habit are the controls |
| Recommendations to use hardware 2FA and encrypt the NVMe | Outside the repository; Matt's decision |
| Resource budgets before benchmarking | Numbers in a document until Phase 0 measures them on the actual Pi |

## 9. Open questions for Matt

1. Accept the Schwab token blast radius as UNVERIFIED-household-wide until Phase 6, and decide whether a dedicated Schwab login for the sleeve is possible (this would convert T-01 from residual to closed).
2. Where does the `LIVE_AUTHORIZATION` signing key live? Recommendation: not on the daily workstation.
3. Cooling-period length for restriction removals. Recommendation: 30 calendar days minimum, longer for first-order ISA themes.
4. Full-disk encryption on the Pi, or explicit acceptance that physical theft yields the encrypted-at-rest secret and its key.
5. Whether off-device notifications may carry ticker symbols at all, given that a symbol plus timing can reveal a restricted-list relaxation.
