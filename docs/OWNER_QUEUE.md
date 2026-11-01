# Owner queue

Generated from `docs/owner-queue.yaml` by `scripts/owner-queue.ts` (D-60). Do not edit by hand; edit the YAML and re-run `npm run owner-queue`. Last updated 2026-11-01.

The plan toward live trading (approved 2026-10-31) puts the 26/52-week prospective clock on the critical path.
Sitting 1 starts it. Everything Claude Code can build without you keeps shipping between sittings; what is
listed here is only what is yours. Reply to decisions as one line each, in the reply format shown, in chat or in
a PR comment; Claude Code records them in docs/DECISIONS.md verbatim.

Legend: **PENDING** is yours this sitting; **BLOCKED** waits on the named PR or release and needs nothing from you yet; **DONE** / **APPLIED** are recorded with who and when. A decision you do not answer is re-proposed next week with the same default; a default is never applied by Claude Code.

## Sitting 1: decisions, GitHub hygiene, downloads, and the clock start

**When:** The Sunday after release 0.1.15 publishes (target 2026-11-08). The decision and GitHub items can be done any time before. (about 70 minutes)

11 pending, 4 blocked, 0 done.

### [PENDING] dn-0: Branching for later PRs

**Question.** CLAUDE.md asks for one bounded phase per PR on claude/phase-XX-short-name from a fresh origin/main. The cloud session is bound to one branch name, which it resets to origin/main after each merge and reuses for the next PR. Keep that (same name, reset after every merge, a new PR each time) or require per-slice names?

**Recommended default.** Keep the session branch, reset to origin/main after each merge, one PR per slice. It satisfies the substance of the rule (fresh base, one bounded PR) without a per-session permission.

**Reply format.** `DN-0: session-branch | per-slice`

**Cost if wrong.** Low; either works, the choice only changes branch names in the PR list.

### [PENDING] dn-1: Who registers the experiment, and where the clock anchors (D-61)

**Question.** `experiment register` starts the 26/52-week clock (OD-10) and is one-way. Who types it, and does the research-store registration anchor the clock while the later evaluation-store child (citable) carries a clock_anchor label instead of restarting it?

**Recommended default.** You, always; Claude Code builds and dry-runs the line. The research store (the only store the shadow job reads) anchors the clock; the evaluation-store child carries `clock_anchor:<research id>:<definitionHash>` and the identical charter hash. A cross-store --parent is impossible: the registry resolves parents in its own database.

**Reply format.** `DN-1: accept | <alternative in one line>`

**Cost if wrong.** A later dispute over which date the 52 weeks count from; settle it before the first seal.

### [PENDING] dn-2: Alpaca paper, then Alpaca live; Schwab deferred (D-62, amends D-12 and D-25)

**Question.** Amend D-12 (sleeve = a dedicated taxable Alpaca brokerage account) and D-25 (Alpaca live is planned for LIVE_MANUAL; one adapter whose only paper/live difference is the configured base URL, so ladder section 6's rung-4 reset for a new adapter does not apply)? Schwab becomes a later decision.

**Recommended default.** Accept as drafted; the live host enters code only in the explicitly approved live-stage PR.

**Reply format.** `DN-2: accept | keep Schwab`

**Cost if wrong.** Reversing later means a second adapter, a second capability register, and a rung-4 re-entry.

### [PENDING] dn-3: Flip the shipped compose to SHADOW and register before the real compliance content exists

**Question.** Release 0.1.15 sets BLACKGOLD_MODE SHADOW and reads policy files from /data/policy. If you register before your signed restricted-list.yaml and theme-membership.yaml are in place, B1 seals every week with new risk blocked (a sealed record, not a missing one) until the signed files land and one `bg shadow rearm --to NORMAL` clears the halt (D-54 b). Start the clock that way?

**Recommended default.** Yes. Section 17 counts missing records and hard-rule violations; a blocked-new-risk record is neither.

**Reply format.** `DN-3: yes | wait for policy content`

**Cost if wrong.** Weeks of clock if you wait; weeks of shadow that exercise no new risk if you do not. Both recoverable.

### [PENDING] dn-4: Amend the permanent CI gate for the paper host (D-63)

**Question.** test/policy/live-disabled.test.ts forbids paper-api.alpaca.markets everywhere. The gate-amendment PR (no network code) would allow it in exactly one gateway egress module, keep api.alpaca.markets and broker-api forbidden until the live-stage PR, and raise the policy floor. Approve that amendment?

**Recommended default.** Approve; it is the test plus capability-register rows, reviewed on its own.

**Reply format.** `DN-4: approve | hold`

**Cost if wrong.** Low; the amendment is one file and reversible.

### [PENDING] dn-8: Over-cap orders are refused, never sliced; the two USD caps (D-55 conflicts 2, 3, 5)

**Question.** Slicing an over-cap order across sessions is a 0.4.0 charter and a clock reset. Refuse instead, and set the two sleeve-size caps in /data/policy/risk.yaml (maxOrderNotionalUsd, maxOrderQuantity) as sleeve parameters outside the charter? Shadow stays scale-free; turnover is gross as risk.yaml 0.2.0 says.

**Recommended default.** Refuse, never slice. Proposal for the caps: maxOrderNotionalUsd = 25 percent of the intended sleeve size, maxOrderQuantity = that divided by 5.00; you enter the number on the Pi, never in chat.

**Reply format.** `DN-8: refuse | slice (new charter); caps: <set on the Pi>`

**Cost if wrong.** Slicing after registration resets up to a year of clock.

### [PENDING] dn-15: GitHub ruleset without a required approval; retire CODEOWNERS

**Question.** D-37 lets Claude Code merge its own PRs; CODEOWNERS and the workflow doc still said owner approval. The ruleset in scripts/github/ruleset.json requires a PR, both CI jobs, resolved review threads, and blocks force-push, with zero required approvals. Import it as is?

**Recommended default.** Yes; you keep tag and ref deletion, and every merge still needs green CI and a passed check-review-state.

**Reply format.** `DN-15: import | require 1 approval`

**Cost if wrong.** Low; a ruleset is edited in the UI in a minute.

### [PENDING] dn-16: Confirm D-54 readings (b) and (c); D-51 closed by the signed 0.3.0

**Question.** (b) one owner re-arm after your signed policy files replace the placeholders; (c) the uniform HOLD_ONLY-after-one-session break mapping, with no per-kind table before registration. And D-51 stands as registered in 0.3.0 (Sharpe difference primary, F2 co-gate).

**Recommended default.** Accept all three as built.

**Reply format.** `DN-16: accept | <change in one line>`

**Cost if wrong.** A per-kind mapping adopted after registration is a policy change inside the prospective record.

### [PENDING] d-40-52-53: Accept, amend or reject D-40, D-52 and D-53

**Question.** D-40 (Granary owns the household layer), D-52 (secrets.env fallback, already live code) and D-53 (the shadow track decomposition) have been Proposed for weeks.

**Recommended default.** Accept all three as written.

**Reply format.** `D-40: accept; D-52: accept; D-53: accept`

**Cost if wrong.** Low; each is reversible and none touches money.

### [PENDING] gh-settings: Default branch, ruleset, stale branches (owner only)

1. GitHub -> Settings -> General -> Default branch: set `main` (if not already).
2. GitHub -> Settings -> Rules -> Rulesets -> New ruleset -> Import a ruleset -> upload scripts/github/ruleset.json (after DN-15).
3. On your machine, in a BlackGold checkout: `scripts/pi/stale-branches.sh` prints one `git push origin --delete ...` line for the fully merged claude/* branches; paste it (or run with --delete).

### [PENDING] downloads: Download the iShares IWM workbook and the three Vanguard distribution files

1. iShares Russell 2000 ETF page -> "Detailed Holdings and Analytics" -> saves as iShares-Russell-2000-ETF_fund.xls.
2. Open and save each as JSON, naming the fund in the file name: https://advisors.vanguard.com/investments/products/api/funds/0970/pricing/distributions (VTI), .../0966/... (VTV), .../0967/... (VUG).
3. Keep them with your other Black Gold files; d57-reconcile.sh stages them on the Pi in sitting 2.

### [BLOCKED] update-0115: Back up, then update the Pi to 0.1.15 (the long form, once; the wrappers arrive with this update)

Blocked by: release 0.1.15 (PR B2) published and pinned

```bash
sudo docker exec blackgold-trading_core_1 node packages/core/dist/main.js backup
sudo docker exec blackgold-trading_core_1 node packages/core/dist/main.js health
# umbrelOS: App Store -> Community App Stores -> Black Gold -> refresh -> Update
# then the next item installs the wrappers from the new image, and ends with: pi-update.sh after
```

### [BLOCKED] install-wrappers: Install the Pi wrappers from the 0.1.15 image and set your signer name

Blocked by: the update to 0.1.15 above (the 0.1.14 image has no /app/scripts/pi)

```bash
mkdir -p ~/bg
sudo docker cp blackgold-trading_core_1:/app/scripts/pi/. ~/bg
sudo chown -R "$USER" ~/bg
echo 'export PATH="$HOME/bg:$PATH"' >> ~/.profile
echo 'export BLACKGOLD_SIGNER="Matt Herman"' >> ~/.profile
export PATH="$HOME/bg:$PATH"
export BLACKGOLD_SIGNER="Matt Herman"
bg health
pi-update.sh after
```

### [BLOCKED] policy-sign: Create /data/policy, set the two USD caps, sign risk.yaml (and the compliance files if their content is ready) (owner only)

Blocked by: release 0.1.15 (PR B2), which ships `policy init|verify|sign`

```bash
bg policy init --dir /data/policy
bg policy verify --dir /data/policy
# set maxOrderNotionalUsd and maxOrderQuantity for your sleeve (DN-8), then sign:
bg policy sign --dir /data/policy --file risk.yaml --signer "$BLACKGOLD_SIGNER" --set orderLimits.maxOrderNotionalUsd=<usd> --set orderLimits.maxOrderQuantity=<shares>
bg policy verify --dir /data/policy
```

### [BLOCKED] register: Snapshot, dry-run, then register charter 0.3.0 (starts the clock) (owner only)

Blocked by: release 0.1.15 (B1's `experiment` CLI, merged, plus B2's SHADOW compose) installed on the Pi, and DN-1, DN-3, DN-8, DN-16 answered

```bash
# bg health must print a 40-hex buildCommit (a CI image) and mode SHADOW; otherwise register is refused, by design
bg snapshot create --dataset prices_daily --description "shadow clock start"
# copy the snapshotId from the output into the next two lines; read the dry run (uncovered must be empty, shadowClock.startsClock true)
bg experiment register --charter strategies/etf-trend-vol/charter.yaml --snapshot prices_daily=<id> --registered-by "$BLACKGOLD_SIGNER" --dry-run
bg experiment register --charter strategies/etf-trend-vol/charter.yaml --snapshot prices_daily=<id> --registered-by "$BLACKGOLD_SIGNER"
bg shadow status --charter strategies/etf-trend-vol/charter.yaml
```

The research-store registration is non-citable by construction (Tiingo's single-source actions label it
`UNVERIFIED_SINGLE_SOURCE`); it anchors the clock. The citable child comes later on the evaluation store
with `--require-citable --no-shadow-clock`. Runbook: `docs/runbooks/register-experiment.md`.

## Sitting 2: policy files, the paper account, notifications, first reconcile pass

**When:** The Sunday after sitting 1 (target 2026-11-15), after release 0.1.16. (about 60 minutes)

7 pending, 3 blocked, 0 done.

### [PENDING] dn-5: The sleeve identifier for PAPER, and a separate paper account

**Question.** How do core and the gateway receive the same sleeve identifier without either inferring it, and may the market-data Alpaca key double as the paper trading key?

**Recommended default.** The sha256 of a DEDICATED Alpaca paper account id, written once by you into /data/policy/sleeve.yaml and signed with `bg policy sign`; both containers read it from the shared /data mount. A separate paper account and keys; the market-data key never trades.

**Reply format.** `DN-5: accept | <alternative>`

**Cost if wrong.** A key that both reads data and trades sits in core, against the credential boundary.

### [PENDING] dn-6: Core to gateway transport and authentication (D-64)

**Question.** How does core hand a signed OrderIntent to the gateway and read its book back?

**Recommended default.** HTTP inside the compose network with no published port; an HMAC-SHA256 envelope over the canonical intent keyed by BLACKGOLD_GATEWAY_HMAC_KEY, which you place in both secrets files; mode and halt state in the envelope, the gateway failing closed to the more restrictive. Stated plainly: both containers share uid 1000 and /data, so the HMAC proves origin and integrity, not a privilege boundary.

**Reply format.** `DN-6: accept | <alternative>`

**Cost if wrong.** Reworking the seam after the paper rung starts means a new gateway version (ladder section 6).

### [PENDING] dn-7: ntfy delivery, public topic or self-hosted

**Question.** Where do missed-run, incident and pending-re-arm notifications go?

**Recommended default.** Public ntfy.sh with a random 32-character topic held in secrets.env as BLACKGOLD_NTFY_TOPIC_URL; bodies are redacted and never carry a dollar figure; revisit before PAPER.

**Reply format.** `DN-7: ntfy.sh | self-hosted <url>`

**Cost if wrong.** Low; the topic URL is one line in secrets.env either way.

### [PENDING] dn-9: Protection for paper entries under a charter with no price stop (D-65)

**Question.** Alpaca brackets need a take-profit and a stop; charter 0.3.0 has no stop. Declare NONE_BY_CHARTER on every intent, bound to the charter hash, with a new OPEN_NO_PROTECTION_REQUIRED order state reachable only on that declaration? Any charter declaring a stop keeps PROTECTION_PENDING mandatory.

**Recommended default.** Yes; never a locally emulated stop called PROTECTED.

**Reply format.** `DN-9: accept | <alternative>`

**Cost if wrong.** A filled entry sits in PROTECTION_PENDING forever, or protection is faked on the Pi.

### [PENDING] dn-10: Order-time quote source and freshness

**Question.** Which quote feeds the order caps and the spread check, and how old may it be?

**Recommended default.** data.alpaca.markets latest quote (IEX, already an allowlisted host), maxQuoteAgeMs 60000, limit = ask for buys and bid for sells, with a dated capability-register row.

**Reply format.** `DN-10: accept | <alternative>`

**Cost if wrong.** Low; a config value plus a register row.

### [PENDING] dn-11: Bounded probes against the paper account while the Pi is at rung 2

**Question.** May the gateway run far-from-market limit-then-cancel probes (duplicate client_order_id semantics, rate limits, websocket, fill rule) on the paper account during SHADOW, as rung-4-style capability probes?

**Recommended default.** Yes; no intent is formed from a decision, and the recordings become the adapter's fixtures.

**Reply format.** `DN-11: yes | no`

**Cost if wrong.** The adapter ships on hand-built fixtures until the probes run.

### [PENDING] dn-12: Claude Code drafts the ~190 curated corporate-action rows for your audit and signature

**Question.** Under D-57(a), may Claude Code draft the curated CSV rows (VTI/VTV/VUG before 2016-12, QQQ) from SEC EDGAR N-CSR/N-30D tables and your QQQ download, each citing its document, for you to audit and sign?

**Recommended default.** Yes, with you auditing every reconciler disagreement/oneSided/setAside row, every structural row and a 10 percent sample of the rest; the reconciler cross-checks every row against Tiingo; you sign.

**Reply format.** `DN-12: yes | I curate`

**Cost if wrong.** Your hours, or a row copied from the wrong document; the audit rule is the guard.

### [BLOCKED] compliance-sign: Sign restricted-list.yaml and theme-membership.yaml, then the one re-arm (D-54 b) (owner only)

Blocked by: your real compliance content, and release 0.1.15

```bash
# edit /data/policy/restricted-list.yaml and theme-membership.yaml with your content first
bg policy sign --dir /data/policy --file restricted-list.yaml --signer "$BLACKGOLD_SIGNER"
bg policy sign --dir /data/policy --file theme-membership.yaml --signer "$BLACKGOLD_SIGNER"
bg policy verify --dir /data/policy
bg shadow status --charter strategies/etf-trend-vol/charter.yaml
# the one re-arm (D-54 b). If shadow status lists unresolved breaks, read them first and add
# --acknowledge <break,...> to the line below.
bg shadow rearm --charter strategies/etf-trend-vol/charter.yaml --to NORMAL --actor "$BLACKGOLD_SIGNER" --reason "signed restricted-list and theme-membership replaced the placeholders (D-54 b)"
bg shadow status --charter strategies/etf-trend-vol/charter.yaml
```

### [BLOCKED] paper-keys: Create the dedicated Alpaca paper account and place its keys where only the gateway reads them (owner only)

Blocked by: PR C2 (gateway foundations) in release 0.1.16, and DN-5, DN-6

```bash
sudo mkdir -p ~/umbrel/app-data/blackgold-trading/gateway-secrets
sudo tee ~/umbrel/app-data/blackgold-trading/gateway-secrets/gateway.env >/dev/null <<'EOF'
BLACKGOLD_ALPACA_PAPER_KEY_ID=<paper key id>
BLACKGOLD_ALPACA_PAPER_SECRET_KEY=<paper secret>
BLACKGOLD_GATEWAY_HMAC_KEY=<32 random bytes, hex>
EOF
sudo chown -R 1000:1000 ~/umbrel/app-data/blackgold-trading/gateway-secrets
echo 'BLACKGOLD_GATEWAY_HMAC_KEY=<the same hex>' | sudo tee -a ~/umbrel/app-data/blackgold-trading/secrets/secrets.env >/dev/null
# umbrelOS: restart Black Gold, then:
bg-gateway credential-check
```

### [BLOCKED] reconcile-first-pass: First reconcile pass against the research store

Blocked by: the downloads from sitting 1 and release 0.1.15

```bash
d57-reconcile.sh vti.json vtv.json vug.json iShares-Russell-2000-ETF_fund.xls
```
