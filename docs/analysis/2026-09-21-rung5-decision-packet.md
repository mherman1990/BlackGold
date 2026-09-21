# Decision packet — the critical path to Rung 5 (LIVE_MANUAL)

2026-09-21. One sitting. Everything here is on the critical path to a live MVP
(Rung 5, `LIVE_MANUAL`, trivial size, every order human-approved) or gates a
parallel track that must start now. Sources: `docs/AUTOMATION_AND_LIVE_GATES.md`
§2/§4, `strategies/etf-trend-vol/ALPHA_CHARTER.md` §14/§17, `STATE.md`,
`docs/analysis/2026-09-20-blocker-queue.md`.

## 0. The number first: Rung 5 is at minimum ~12 months of wall clock away, and the clock has not started

**Verified facts.** The charter fixes two elapsed-time gates no engineering
compresses:

- **SHADOW → PAPER: 26 weekly sealed decisions** with zero missing records and
  zero hard-rule violations (§17). ≈ 6 months.
- **PAPER → LIVE_MANUAL may be *considered* at 52 weekly prospective decisions
  (12 months), zero hard-rule violations** (§14.3). The charter itself says 12
  months of weekly data cannot distinguish skill from noise; Rung 5 is an
  execution-calibration gate, not an alpha gate.

§14.1/§14.2 date the prospective record **from experiment registration**: from
registration onward, every weekly decision is sealed before the next open. So
the earliest possible Rung 5 date is roughly **registration + 12 months**, with
PAPER entered at registration + ~6 months (if slice 4, B-5 and B-6 are ready by
then — they have half a year of slack).

**The trap (inference, high confidence):** any charter edit is a new version at
DRAFT inheriting no evidence — including the prospective record. If the shadow
clock starts on 0.2.0 and you later fix B-1, the §16.1/§17 contradiction, the
§14.3 schedule shortfall, or overrule either Secondary-2 reading, the sealed
decisions become evidence for a strategy version that no longer runs, and the
clock restarts. **Therefore every charter question must be settled in one batch,
cut once as 0.3.0, signed, and only then registered.** Right now a 0.3.0 cut is
nearly free (0.2.0 has zero citable evidence to lose). After registration it
costs up to a year.

**One ambiguity I flag rather than resolve (a guess either way):** whether
decisions sealed between registration and the owner's ACTIVE acceptance (§17
requires the Rung-1 primary metric passed first) count toward the 26/52. §14.2
says yes ("from registration"); §17's ladder reads as if SHADOW starts at
ACTIVE. If the strict reading holds, the clock starts even later — at ACTIVE,
which also waits on B-2's citable data. Worth one sentence from you in the
0.3.0 cut, because the two readings differ by months.

## 1. The dependency chain

```
[Matt: charter bundle → 0.3.0 signed]───┐
[Claude: shadow runner 2c + 3a-3 + 3b]──┼─→ register 0.3.0 → CLOCK STARTS
[Matt: B-3/B-4 content (before start)]──┘        │
                                                 ├─ +26 wk → PAPER  (needs slice 4 ← B-5 + B-6)
[Matt: B-2 remedy + delegation]                  │
   └→ citable data → Rung-1 evidence →           ├─ Rung 4 ← D-13 + Phase 6 gateway (Claude builds)
      owner ACTIVE acceptance (parallel)         │
                                                 └─ +52 wk → Rung 5 eligible ← LIVE_PROMOTION + LIVE_AUTHORIZATION (yours)
```

Only you: every charter value, B-2's evidential standard, B-3/B-4/B-5 content,
credentials, D-13, signatures, GitHub settings, ACTIVE acceptance, promotion.
Only me, no answers needed: the `computeFeatures` double-count fix (in the PR
carrying this packet), slices 3a-3, 2c, 3b, Phase 6 gateway machinery, drafting
0.3.0 and every artifact above for your signature.
Calendar-gated: everything right of "CLOCK STARTS".

## 2. Decisions, ordered by how much each unblocks

### D-packet-1. The charter bundle → one 0.3.0 cut  *(most of it is five minutes; B-1 is the one that needs thought)*

Everything here is a charter value, so deciding them piecemeal burns a version
each. Decide together, I draft 0.3.0, you sign once.

**(a) B-1 / D-51 step 3 — the primary promotion metric.** Question: is a
Sharpe-difference the right primary gate for a strategy whose reason to exist
is crash protection? Options: keep it (most conservative; the sleeve must earn
risk-adjusted return, and §11's secondary metrics already report drawdown) /
keep Sharpe primary + add an explicit max-drawdown-ratio or Calmar co-gate
(my **recommendation**: it makes the thesis falsifiable on its own terms
without softening the return hurdle; ≤ 0.75 MaxDD-ratio is already §13's
stated target, so it is codifying an intent, not inventing one) / replace with
Sortino or Calmar (weakest: nonstandard, and invites "chose the metric the
strategy passes"). Cost of wrong: discovered after registration, it is 0.4.0
plus a clock reset — up to a year.

**(b) §16.1 vs §17.** When the primary fails and Secondary 2 passes, §16.1 says
OWNER_REVIEW, §17 says REJECTED-never-ACTIVE. One sentence picks a winner.
**Recommendation:** §16.1 (owner review) — a human reviewing a mixed verdict is
strictly safer than code auto-rejecting on a contradiction, and rejection stays
available to you at review. Cost of wrong: small; it only binds in the mixed
case.

**(c) §14.3's 150-block minimum vs the ~102 the registered walk-forward
schedule can reach.** Either lower the minimum to what 2010-06→2018-12 supports,
or extend the schedule's span. **Recommendation:** restate the minimum as the
schedule's actual capacity and say so honestly in §14.3 — extending the span
eats into DESIGN or toward the holdout boundary, which is worse. Cost of wrong:
a verdict that is formally out of spec with its own charter, forever arguable.

**(d) The two Secondary-2 readings** (weekly re-scaling cadence at decision
instants; ex-date income reallocated at the open). Both are implemented; both
are charter silences. Confirm or overrule each in one line; confirmations go
into 0.3.0 text and `SECONDARY_2_OPEN_READINGS` comes off every verdict.
**Recommendation:** confirm both as implemented (each was argued through Codex
review; the alternatives differ only on rebalance-coincident sessions). Cost of
wrong: negligible if confirmed now; a post-registration overrule is a version.

**(e) The §14.2-vs-§17 clock-start ambiguity** from §0. One sentence.
**Recommendation:** "prospective decisions count from registration" — it is
what §14.2 already says, and the strict reading only delays evidence without
adding safety (the decisions are sealed either way).

### D-packet-2. B-2 — the corporate-action evidence base  *(real thought)*

Two questions, and the second must be answered before any data work is
commissioned or the work buys nothing (the taint mechanics are in the
2026-09-13 path-to-citable-evidence note; unchanged).

**(a) May I build a second automated public corporate-actions adapter plus a
machine reconciler emitting the ≥2-source file, instead of you hand-curating?**
This is an evidential-standards call, not engineering: D-29/D-49 say
*operator-curated*, and the point of the rule is that I am not the sole author
of my own evidence base. **Recommendation:** yes, with the reconciler's output
requiring your sign-off per universe before ingest (you audit and approve the
file; machines fetch and cross-check). That keeps a human owner in the
evidence chain and turns weeks of hand-curation into a bounded PR plus one
review sitting. A "no" is legitimate and costs only your time.

**(b) The taint remedy.** Reconciled rows landing in the current Pi store stay
tainted by the coexisting Tiingo rows. Options: a separate store for the
evaluation universe (cheapest, zero code, my **recommendation**) / change the
taint rule (an evidence-standards change I should not make) / build a
quarantine mechanism (real code for no extra safety). Cost of wrong: the whole
curation effort produces zero citable runs.

Note the ordering: B-2 gates the Rung-1 result and your ACTIVE acceptance, but
under the "counts from registration" reading it does **not** gate the clock.
It can run in parallel during the first shadow months. Decide (a)/(b) this
week; the data work has ~2–3 months of slack before it becomes the binding
constraint.

### D-packet-3. The five-minute pile — clear these tonight

Disproportionate unblock for the effort, and I stall on none of them today,
but each becomes binding within weeks:

- **B-5 (D-12):** does the sleeve account exist, and its type. Gates slice 4.
- **B-6:** Alpaca paper keys into `secrets.env` on the Pi. Gates slice 4.
- **D-13:** written blast-radius acceptance. Gates Rung 4; one paragraph.
- **B-8:** default branch + protection; prune the 39 verified-safe branches;
  pick a side on the `v*` tag contradiction (either answer is fine).
- **B-4's three numbers:** look-through threshold (§2.2's 10%?), aggregate
  vs per-theme (aggregate?), holdings freshness limit. The issuer→theme map
  can follow; the numbers let 2c ship configured rather than placeholder.

### D-packet-4. B-3 / B-4 content — needed before the clock starts, not today

The restricted list and theme map are yours alone. **They matter earlier than
they look:** 26 shadow weeks in which B1 is permanently blocked by
`UNKNOWN_LOOK_THROUGH` or a placeholder list would be operationally clean but
would not exercise the strategy — weak Rung-2 evidence at best, a restart at
worst. Target: real content ingested before registration day.

## 3. What I am building meanwhile (no answers needed)

In order, one bounded PR each: the `computeFeatures` double-count fix (this
PR — prerequisite to B-2 under every remedy); slice 3a-3; slice 2c; slice 3b;
then slice 4 the day B-5/B-6 arrive. Then Phase 6 gateway machinery, which
Rung 4 needs and which has months of slack but nonzero size.

## 4. Summary of costs if decided wrong

| Decision | Wrong-answer cost |
|---|---|
| Charter bundle (D-packet-1) after registration | New version, prospective clock resets: up to 12 months |
| B-2 remedy before curation | Weeks of data work producing nothing citable |
| B-2 delegation | "No" costs your hours; "yes" without sign-off weakens the evidence standard |
| Five-minute pile | Days of stall each, weeks from now, at moments that will feel urgent |
| B-3/B-4 late | Shadow months that exercise nothing; possibly re-run them |
