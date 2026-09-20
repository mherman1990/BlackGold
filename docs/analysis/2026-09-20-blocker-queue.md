# Blocker queue — 2026-09-20

A resume note for the next working session. It has three parts: where the build
actually is (verified from `main`, not from the stale `STATE.md` header), the
decisions only Matt can make, and the work Claude Code can do without any of
them. Nothing here changes code, a charter, a metric, or an approval.

`STATE.md` was last stamped 2026-09-12 and `HANDOFF.md` 2026-09-08; `main` has
merged roughly thirty commits since, through PR #86. Where the two disagree,
`main` is right. Refreshing both is on the "no owner input needed" list below.

---

## 1. Where the build is (verified)

**Merged to `main`**, at `4f5d005` when this note was written and `765fde8` after the note itself merged (PR #88). 829 tests, `npm run check` green.

| Layer | State |
|---|---|
| Phases 0–3 | Merged. Foundation, point-in-time research kernel, first deterministic charter, bounded runtime-LLM analyst overlay + Anthropic adapter |
| Phase 4 engines | Factor classifier, halt-state machine, risk-limit/caps engine, compliance engine — all merged, all pure, all fail-closed |
| Phase 5 gate | `decision/gate.ts` merged (PR #35): halt ∧ limits ∧ new-risk-compliance composed into one go/no-go |
| Phase 5 shadow track (D-53) | Slice 1 (sealed prospective decision record + migration `0008`), 2a (per-arm target book), 2b (gate-and-seal), 3a-1 (look-through engine), 3a-2 decoder (SSGA `.xlsx`) and 3a-2 fetch (PIT ingest, PR #87) — **all merged**. Remaining: 3a-3, 2c, 3b, 4 |
| Release | **0.1.12 published and running on the Pi.** GHCR public, image digest-pinned in the compose. Releases now cut by `release.yml` dispatch (D-38) |
| Data | Tiingo EOD bars ingested on the Pi (96,288 bars, 2000–2026) + Tiingo corporate actions (D-49, `UNVERIFIED_SINGLE_SOURCE`). FRED / SEC / CFTC / Alpaca adapters live-verified. Opt-in nightly auto-ingest shipped (0.1.11/0.1.12) |
| Evaluation engine | `research evaluate` shipped (0.1.9/0.1.10) and **run end to end on real data** on 2026-09-13 — see `2026-09-13-etf-trend-vol-machinery-check.md` |
| Charter | `etf-trend-vol` **0.2.0 signed** (Tiingo default, D-50). `registrable: true` |
| Live trading | Absent by construction. No broker credential exists anywhere |
| Registered experiments | **Still none.** No result is citable, no holdout opened |

**PR #87 is merged** — SSGA holdings fetch adapter (D-53 slice 3a-2 fetch), in
`main` as of 2026-09-20 at `4f5d005`. It had sat green and idle for five days
with one Codex P1 already fixed (point-in-time correction ordering). Merging it
unblocked slice 3a-3.

### The thing to understand about the 2026-09-13 run

The machinery works. Two `research evaluate` runs produced economically coherent
output: on DESIGN (2007–2018, contains the GFC) the strategy captured ~83% of
passive total return while cutting max drawdown from −54% to −13%. On RECENT
(2025–present, uninterrupted bull) it lagged badly, as a trend follower should.

Both runs are `citableAsEvidence: false`. And on its **own** primary promotion
metric — `net_sharpe_difference_vs_primary_benchmark`, threshold +0.10 — the
strategy reads −0.19 on the very window it was fit to. It fails its own gate
in-sample. That is the substance behind decision **D-51** below, and it is the
most important open question in the project.

---

## 2. Blockers — owner decisions and owner data

Ordered by how much each unblocks. Each is something Claude Code is structurally
forbidden from doing (`CLAUDE.md`, "What standing authorization never covers") or
simply does not have the information for.

### B-1. D-51 — is the primary promotion metric right for this strategy?

**Blocks:** everything downstream of a registered experiment. There is little
point registering an experiment against a gate you do not believe measures the
thing.

The strategy's stated reason to exist is tail-risk / drawdown reduction. A
full-period Sharpe difference is nearly blind to a 40-point drawdown gap. Options:

- **Keep it.** The sleeve must earn its keep on risk-adjusted return, not just
  crash protection. Defensible, and the most conservative reading.
- **Add a constraint.** Keep Sharpe as primary, add an explicit max-drawdown
  ceiling or a Calmar/MAR gate alongside it.
- **Change the primary.** Sortino, or Calmar, as the primary promotion metric.

Any change is a **charter edit → version 0.3.0 at DRAFT**, inheriting none of
0.2.0's work, and needs Matt's signature. Claude Code may draft the charter; it
may not sign it or decide the metric.

### B-2. Corporate-action reconciliation — the citability blocker

**Blocks:** any citable run, and therefore any promotable result.

`UNVERIFIED_SINGLE_SOURCE` comes from the **corporate-action** rows, not the
bars. The Tiingo actions adapter stamps it unconditionally. The only
promotion-eligible path is a vendored file where each entry names ≥2 distinct
sources (`ingest corporate-actions --file`). Scope: the 12-ETF universe + BIL +
VTI, DESIGN window 2007-06-01 → 2018-12-31, on the order of a few hundred
quarterly dividend entries plus a handful of structural actions. Details in
`2026-09-13-path-to-citable-evidence.md`.

**A second decision, found 2026-09-20 and larger than it looks: curating the
file clears nothing on its own.** The Tiingo action rows are already in the Pi
store. A snapshot is bound by `max(observations.id)` so it includes them; both
paths write under the same `corporate_action.<KIND>` source id so a run cannot
select one and ignore the other; and `loadExecutionSeries`
(`research/backtest.ts`) accumulates promotion-blocking codes over **every**
returned row *before* the dedupe picks the reconciled winner — deliberately, so
the dedupe can never flatter the store. Curating into the current store
therefore leaves the label in place. **Decide the remedy before commissioning
the curation**, or the data work buys nothing: a separate store for the
evaluation universe (cheapest, no code change), a change to the taint rule (an
evidence-standards decision, not a refactor), or a quarantine mechanism that
does not exist. Costs are in `2026-09-13-path-to-citable-evidence.md`.

**The decision Matt owes, and it is not just "do the data work":** may Claude
Code build a *second automated* public corporate-actions adapter (issuer
distribution notices + an exchange feed) plus a reconciler that emits the
≥2-source file, instead of Matt hand-curating it? D-29/D-49 describe the
reconciled file as *operator-curated*. Whether two independently-fetched
allowlisted public sources, machine-reconciled, satisfy the spirit of that rule
is an owner call about evidential standards, not an engineering question. A yes
turns weeks of manual curation into a bounded PR. A no keeps the curation with
Matt, and that is a legitimate answer — the whole point of the rule is that the
agent should not be the sole author of its own evidence base.

### B-3. Restricted-list content

**Blocks:** compliance ever clearing a candidate; slice 2c; any shadow run whose
B1 arm is meant to pass its gate.

`config/examples/restricted-list.yaml` holds deliberate placeholders. The real
list encodes Matt's nonpublic ISA restrictions — employer, suppliers, themes.
Claude Code did not and will not author it. Needed: the actual entries, plus the
cooling-period value for removals (D-14 mechanics are built).

### B-4. Theme-membership config and three compliance-policy numbers

**Blocks:** D-53 slice 3a-3, and therefore the shadow B1 arm clearing
`UNKNOWN_LOOK_THROUGH`.

The look-through engine (merged) takes an issuer→theme map and three parameters
as inputs. Claude Code can ship the schema and a fake example; the content and
the numbers are Matt's:

- The **issuer→restricted-theme map**.
- The **threshold**: ALPHA_CHARTER §2.2 proposes 10% of NAV. Confirm or set.
- **Aggregate vs per-theme**: §2.2 reads as aggregate; 3a-1 implements aggregate.
  Confirm.
- **Freshness limit**: how stale published holdings may be before look-through
  returns unknown and compliance fails closed.

OD-1 is marked interim pending counsel; if counsel is in the loop, this is the
item to route there.

### B-5. D-12 — the sleeve account

**Blocks:** D-53 slice 4 (the Alpaca paper adapter) and every order-path test,
because an `OrderIntent` carries the sleeve account id and the gateway re-checks
it.

Does the ring-fenced account exist? What type? This has been open since
Discovery.

### B-6. Alpaca **paper** keys, scoped to the paper base URL

**Blocks:** D-53 slice 4. Pairs with B-5. These go in
`${APP_DATA_DIR}/secrets/secrets.env` on the Pi (D-52), never in git.

### B-7. Which factor tags are cap-bearing

**Blocks:** the deferred factor-concentration limit.

The taxonomy's `market` tag sits on every holding, so capping summed `market`
weight would cap total exposure. `maxFactorWeightPct` is therefore deliberately
unenforced rather than enforced wrongly. Which tags the cap applies to is a
charter/policy decision.

### B-8. GitHub settings Claude Code cannot touch

- Set `main` as the **default branch**; add a ruleset requiring a PR, status
  checks (`checks`, `image`), no force pushes.
- **Prune the stale branches.** Not three, as `STATE.md` said — **79**. Verified
  2026-09-20: **39 are strict ancestors of `origin/main`** and are unambiguously
  safe to delete. The other 40 predate merges that rewrote SHAs, so ancestry,
  `git cherry` and subject matching all over-report; each needs a content check
  nobody has done. This session's credential is refused ref *deletion* (HTTP
  403); there is no workaround.
- **Resolve the `v*` tag contradiction.** D-37 grants Claude Code tag creation;
  the credential is refused tag refs. Today the refusal is doing the work of a
  policy nobody wrote. Either amend D-37 to drop tag creation (releases wait on
  Matt by design) or grant tag-ref permission. `release.yml`'s own guard already
  enforces what matters — the tag must match `package.json` and be reachable from
  `main` — so a bad tag cannot publish anything. Either answer is fine; the
  mismatch is not.

### B-9. Smaller open facts

- **D-16**: backup destination host.
- **D-04**: port-collision check on the Pi.
- **D-13**: written blast-radius acceptance (gates Phase 6).
- **D-40**: accept or reject the Granary split (blocks no current work, but the
  dollar-free export contract is designed and buildable once accepted).
- **CR-12/CR-13**: one live analyst run against the real Anthropic API on the Pi.
  Now unblocked mechanically — `ANTHROPIC_API_KEY` reaches the container through
  `secrets.env` (D-52). Needs Matt to drop the key in and run it once.
- **Pi hardware checks**: `scripts/pi-benchmark.sh` against
  `docs/RESOURCE_BUDGET.md`.

---

## 3. What Claude Code can build with none of the above

So a day is never lost waiting on an answer. Each is a bounded, reviewed PR.

1. ~~**Merge PR #87**~~ — **done 2026-09-20** (`4f5d005`). Unblocks 3a-3.
2. **D-53 slice 3a-3, the half that is ours**: theme-membership schema + fake
   example + wire `lookThroughResolver` into the shadow decision path. Real
   content arrives later via B-4 without a code change.
3. **D-53 slice 2c**: the mode-gated `after_close` `serve` job, with
   `risk.yaml` / `restricted-list.yaml` baked into the image at a fixed path,
   versioned and hashed (Matt decided this on 2026-09-14). Buildable against the
   example files; swapping in the real ones is a config act.
4. **D-53 slice 3b**: counterfactual fills + reconciler/steward + incident
   records. Internal simulator only, zero broker contact. This is the largest
   remaining piece that needs nothing from Matt.
5. **Bars cross-source verifier**: compare `tiingo.eod.bars.1d` against
   `alpaca.iex.bars.1d`, register a new bar-level quality code, fold it into
   `promotionBlockingCodes`. Worth real data-integrity confidence. It does
   **not** clear the citability label — that is B-2 — and should not be sold as
   if it does.
6. ~~**Refresh `STATE.md` and `HANDOFF.md`**~~ — **done 2026-09-20**, in the PR
   that carries this note. It turned up two things worth keeping: the charter
   banner below, and the stranded-branch pattern in §5.
7. **Deferred Phase 4 limit engines** that need only price/ADV data already in
   the store: liquidity and order-level limits. Per-position risk budget and
   factor concentration wait on B-7.

## 5. Two things the refresh turned up

**The charter was lying about itself.** `strategies/etf-trend-vol/charter.yaml`
carried a banner reading `STATUS: DRAFT (charter_version 0.2.0) - AWAITING OWNER
SIGNATURE` sitting directly above `state: APPROVED` / `approved_by: Matt Herman`
/ `approval_date: 2026-09-12`. A session trusting the banner over the block would
have concluded the strategy was unregistrable and gone looking for work already
done. Corrected in this PR — comments only; `charterHash` is computed over the
canonical JSON of the *parsed* charter, so no comment edit can touch the signed
hash `sha256:5c7f94da…`.

**Work gets stranded here, repeatedly.** That banner fix was not new: a session
wrote it on 2026-09-14 (`7e30599` on `claude/busy-meitner-as415q`), committed it,
pushed it, and never opened a PR. It sat for six days while the banner stayed
live on `main`. The same thing had happened to D-53 slice 2a (`199e25e`), which
was luckier and got merged as PR #82. Both were invisible to later sessions for
the same reason: sessions read `STATE.md`, and a branch with no PR never updates
it. **Before rebuilding anything, check whether a branch already has it.**

---

## 4. One thing worth saying plainly

The machinery is in good shape and the evidence is not. Nine phases of
fail-closed engines, 829 tests, a working point-in-time evaluation loop on real
Pi-ingested data — and zero registered experiments, zero citable runs, a sealed
holdout, and a strategy that fails its own preregistered gate on the window it
was fit to.

That is not a criticism of the build; it is what the build was designed to
surface, and it surfaced it before any capital moved. But it means the next
genuinely valuable move is **B-1 and B-2** — decide whether the gate measures the
right thing, and decide how the corporate-action evidence base gets built. Slices
3a-3, 2c and 3b are real work and they climb no rung. Rung-2 shadow evidence
still cannot precede the Rung-1 experiment.
