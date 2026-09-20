# D-51: the metric question is premature, because the decisive falsifier has never been evaluated

**Status:** analysis for the owner. It decides nothing. Changing a promotion metric is a charter edit and
therefore a new strategy version, which is the owner's act (`CLAUDE.md`, "What standing authorization never
covers").

D-51 asks whether `net_sharpe_difference_vs_primary_benchmark` is the right *primary* promotion metric for a
strategy whose stated thesis is drawdown reduction. Reading the charter and the code against each other
changes the question. The short version:

1. The charter **already** values drawdown, in two places D-51 does not mention.
2. The charter's **decisive** falsifier is a conjunction, and only one half of it has ever been computed.
3. `research evaluate` — the command that produced the evidence — **dropped every number except the primary
   metric**, which is why nobody noticed either fact.
4. So "the strategy fails its own gate" is wrong twice over. The DESIGN primary-metric number is a
   **per-window diagnostic, not an F1 verdict** — §13 defines the pass rule "on the aggregate walk-forward
   out-of-sample set", and DESIGN is in-sample (§2c). And §16.1's status is not merely unknown.
5. **§16.1 cannot be computed today at all**, because the benchmark it names — Secondary 2 — is not
   implemented (§2a). (Both this and the point above were found by Codex review of earlier drafts of this
   note, not by the drafts themselves.)

Changing the primary metric now, having seen that it failed, would be metric-shopping. Computing a number the
charter preregistered and nobody looked at is not. That ordering is the whole recommendation.

---

## 1. What the charter already says about drawdown

D-51's premise is that the gate "is nearly blind to the tail". The primary *metric* is. The **charter** is not:

| Where | What it says |
|---|---|
| §4 Hypothesis | The strategy "claims to change the shape of the return distribution … enough to raise **Sharpe and Calmar** after costs and taxes." |
| §13 Outcome metrics | Secondary risk metrics include "maximum drawdown and ratio to VTI maximum drawdown (target at or below 0.75); **Calmar**; CAGR; worst 21-session return …" |
| §16.2 / `pass_fail` | **F2**: "Maximum drawdown not at or below `max_drawdown_ratio` (0.75) times the primary benchmark's." |

So there is already a hard drawdown falsifier, and Calmar is already named — in the hypothesis itself and in
the metric list. What is missing is not the *intent* to value drawdown. It is that **no falsifier tests
Calmar**, and that F2 and the secondary metrics were never reported.

On the (non-evidential) 2026-09-13 numbers, F2's arithmetic is:

| Split | Strategy max DD | VTI max DD | Ratio | F2 (limit 0.75) |
|---|---|---|---|---|
| DESIGN | −13.36% | −54.04% | **0.247** | passes comfortably |
| RECENT | −15.36% | −19.22% | **0.799** | **triggers** |

Both runs are `citableAsEvidence: false` (`UNVERIFIED_SINGLE_SOURCE`) and neither is cited here as evidence
for or against the strategy. The point is only that F2 is computable, discriminating, and was not reported —
and that it lands differently on the two windows.

## 2. The decisive falsifier is a conjunction, and half of it is missing

§16.1, verbatim:

> After realistic base costs, the strategy fails to improve the primary metric over VTI on the aggregate
> walk-forward out-of-sample set **AND** fails to beat Secondary 2 (static volatility-controlled VTI). **If
> either passes, the charter goes to owner review**; if both fail, the hypothesis is rejected.

Secondary 2 is the primary benchmark held at the strategy's own average equity weight. It isolates the
question that matters for a volatility-targeted strategy: **does trend selection add anything beyond
volatility control?** Judging such a strategy only against un-vol-controlled VTI confuses the two effects —
which is, in substance, the same worry D-51 raises. The charter's designers already addressed it. They put the
answer in the decisive falsifier rather than in the primary metric.

The code implements the *conjunction* correctly:

```ts
// packages/core/src/research/robustness.ts
const beatsPrimary = m.primaryPointEstimate >= threshold && !outcomes.some((o) => o.id === "F1" && o.triggered);
const beatsVolControlled = m.primaryVersusVolatilityControlled !== undefined && m.primaryVersusVolatilityControlled > 0;
…
decisiveRejection: !beatsPrimary && !beatsVolControlled,
```

`buildResultReport` computes a field called `primaryVersusVolatilityControlled` on every run, and
`runEvaluation` — the function behind `research evaluate` — discarded it along with Calmar, CAGR, the benchmark
metrics and F2's inputs. The 2026-09-13 note reports F1 and nothing else because that is all the operator
surface carried.

## 2a. Correction: the second prong cannot be computed at all yet

The first draft of this note said the second prong existed and only needed surfacing. **That was wrong**, and
Codex caught it on review. The number `buildResultReport` computes is not Secondary 2:

| | Definition |
|---|---|
| **§11 Secondary 2 (registered)** | "VTI scaled to a **10% ex-ante volatility target with the same 63-day estimator**, remainder in BIL" — a dynamically re-scaled series |
| **§11 Secondary 1 (registered)** | `e * VTI + (1 - e) * BIL`, `e` = the strategy's realized average equity weight **per calendar month** |
| **What the code builds as `VOLATILITY_CONTROLLED_PRIMARY`** | VTI held at the strategy's **single constant average** realized equity weight over the whole window |

The code says so itself (`report.ts`): *"The charter's secondary 2 … **Approximated here** by holding the
primary at the strategy's own average equity weight."* That approximation is a coarser **Secondary 1** — same
weights, less granularity — not a volatility-targeted series. Its volatility and return can differ materially
from a 63-day ex-ante 10% target, and nothing in the codebase implements that target.

**Consequence:** §16.1's second prong has never been computed because the benchmark it names does not exist in
code. Treating the approximation as the prong would route a hypothesis to rejection or to owner review against
an unregistered comparator — which is the same class of error as changing the metric after seeing the result,
just harder to notice.

Implementing Secondary 2 is a bounded, preregistered piece of work: the estimator (63-day), the target (10%
ex-ante) and the cash leg (BIL) are all frozen in §11, so it involves no judgement and contaminates nothing.
It is a prerequisite to answering D-51, and it is listed in §5.

## 2b. §16.1 is an aggregate verdict, not a per-split one

Also caught on review. §16.1 applies "on the **aggregate walk-forward out-of-sample set**". A per-split verdict
would state a §16.1 rejection over the **in-sample** DESIGN window, and several walk-forward splits would
produce contradictory verdicts where the charter registers exactly one. The first draft of this PR emitted
exactly that, and the recommendation below told the owner to read it from `--split design`.

Both mistakes are removed: `research evaluate` now emits **no** §16.1 verdict at any level, and the
approximate benchmark is labelled as a diagnostic rather than the prong.

## 2c. F1 is aggregate-scoped too, so "DESIGN fails F1" is a category error

§13: "Pass threshold: point estimate at least +0.10 and the bootstrap interval excludes zero **on the
aggregate walk-forward out-of-sample set**."

DESIGN is in-sample. A single walk-forward window is not the aggregate. So the −0.19 on DESIGN is a
**per-window diagnostic**, not an F1 verdict — and every earlier statement in this session that the strategy
"fails F1", including in earlier drafts of this note, overstated what was measured. `research evaluate` now
lists F1 under `falsifiersNotEvaluated` with that reason, and `primaryMetric.passes` stays what it always
was: a diagnostic.

## 3. What this means for the claim "it fails its own gate"

Almost nothing it was taken to mean.

- The DESIGN primary-metric number (−0.19, CI straddling zero) is real, and in-sample, which makes it
  unflattering. But it is **not** an F1 verdict, because F1 is defined on the aggregate walk-forward set.
- §16.1 rejection is not established and **cannot currently be computed**, because Secondary 2 does not
  exist in code.

So the honest statement is: on the in-sample design window the strategy's Sharpe difference against VTI was
negative, and none of the charter's registered promotion or rejection tests has yet been run at the scope the
charter defines them at.

## 4. Why not to change the primary metric first

Choosing a promotion metric after seeing which metrics the strategy passes is the canonical way to manufacture
a result. The design window has already been evaluated; any metric selected now is selected with knowledge of
the outcome. Three guardrails matter here:

- A metric change is a **new charter version** that inherits none of 0.2.0's work (`CLAUDE.md` versioning
  rule). The evidence base resets; nothing is salvaged by the change.
- §17: "Underperformance over a short window is never by itself a reason to change parameters."
- The standing carve-out: Claude Code may not accept its own research output as investment evidence, nor
  decide that a failed falsifier does not matter. Proposing a metric that happens to pass would be doing
  exactly that in a different costume.

Reporting a preregistered secondary is categorically different from selecting a new primary. The first
recovers information the charter already committed to; the second spends the charter's credibility.

## 5. Recommendation

**Three steps, in order. None of them changes a charter value or decides D-51.**

**Step 1 — implement the registered Secondary 2** (engineering, no judgement). §11 freezes every parameter:
VTI scaled to a 10% ex-ante volatility target using the 63-day estimator, remainder in BIL. Nothing is chosen
after the fact, so this contaminates nothing. Until it exists, §16.1's second prong is not computable and no
§16.1 verdict should be produced by anything.

**Step 2 — evaluate §16.1 over the aggregate walk-forward set**, not per split, and only once Step 1 lands.
This needs the walk-forward splits pooled into the one out-of-sample set the charter registers.

**Step 3 — read the numbers this PR does surface**, which are correct and per-split by nature:

```
node packages/core/dist/main.js research evaluate \
  --path strategies/etf-trend-vol/charter.yaml \
  --source tiingo.eod.bars.1d --split design
```

Per split it now carries `drawdown` (F2 with its ratio and limit), `arms`/`benchmarks` with CAGR, Calmar and
max drawdown (§13), and an explicit list of which falsifiers the run evaluated (F1 and F2). It also carries
`approximateVersusAverageExposureBenchmark`, labelled as a diagnostic and **not** as §16.1's prong. Runs stay
non-evidential while the data carries `UNVERIFIED_SINGLE_SOURCE`.

**Then, once Steps 1 and 2 give a real §16.1 verdict, D-51 splits into two genuinely different questions:**

- **If the strategy beats Secondary 2:** §16.1 already routes this to owner review rather than rejection, and
  D-51 becomes "should owner review be able to promote on a drawdown/Calmar basis?" — a real question, but one
  asked from a position where the charter is working as designed rather than being overridden.
- **If the strategy trails Secondary 2:** §16.1 rejects, and the honest reading is that trend selection adds
  nothing beyond volatility control on this window. Changing the primary metric at that point would be
  rescuing a rejected hypothesis by redefining success. The charter's own answer — REJECTED, results preserved
  — is the one to take.

**Separately, and defensible either way: the Calmar gap.** §4 claims Sharpe *and* Calmar; §13 lists Calmar; no
falsifier tests it. Closing that is a fidelity fix rather than a metric change — the charter already said it.
But note it cuts both ways: adding a Calmar falsifier makes the gate **stricter**, not easier, and adopting it
as the *primary* would still be post-hoc selection. The uncontaminated version is to add Calmar as a falsifier
in a future version and leave the primary alone.

## 6. A charter inconsistency worth resolving in the same pass

§16.1 and §17 disagree about what happens when the primary metric fails but Secondary 2 passes:

- **§16.1:** "If either passes, the charter goes to owner review."
- **§17:** "REGISTERED to ACTIVE (SHADOW) … primary metric passed … **If the metric fails, the charter goes to
  REJECTED, never to ACTIVE.**"

Under §16.1 that case is reviewable; under §17 it is already rejected. Today the contradiction is dormant
because the second prong is unmeasured. It stops being dormant the moment the number comes back positive —
which is the scenario in which it matters most and is hardest to resolve impartially. Worth settling **before**
the number is known.

## 7. What this PR does and does not do

**Does:** surfaces §13's secondary risk metrics (CAGR, Calmar, max drawdown, Sharpe vs cash for every arm and
benchmark) through `research evaluate`, computes F2 with its ratio and limit, and names which falsifiers a
single run actually evaluated (F1 and F2) rather than leaving the rest to be assumed. It labels the
average-exposure benchmark as a diagnostic and explicitly not as §16.1's second prong.

**Does not:** change any metric, threshold, falsifier, or charter value; implement Secondary 2; emit any §16.1
verdict at any level; compute the real numbers (that needs the Pi's store); or decide D-51.

**A known defect this surfaced, not fixed here:** `evaluateFalsifiers` (`robustness.ts`) computes
`decisiveRejection` from the same unregistered approximation, and treats a missing second prong as "does not
beat". Nothing calls it from the CLI today, so it is latent — but as written it would reject a hypothesis
against a comparator the charter never registered. It belongs with the Secondary 2 work.

**Errors this note made across three drafts, all caught by Codex review and all corrected above:**

1. Claimed the second prong merely needed surfacing. It needs Secondary 2 built first (§2a).
2. Emitted a per-split §16.1 verdict that would have stated a rejection over in-sample data (§2b).
3. Kept calling the DESIGN result "fails F1" after removing the §16.1 verdict, when F1 is aggregate-scoped
   by the same reasoning (§2c) — the error was fixed at one level and left at the one below it.
4. Corrected this analysis but left the D-51 register entry asserting the original, wrong version — and
   `docs/DECISIONS.md` is the more authoritative document of the two.

Each was an attempt to *increase* rigour that would instead have put a falsely authoritative number in front
of the owner, and each was found by an independent reviewer rather than by the pass that wrote it. That is
the concrete case for the review coverage `STATE.md` has been asking for since PR #9.

Worth stating plainly: the underlying situation is unchanged and may still be bad. The strategy failed F1
in-sample, and RECENT looks poor on both F1 and F2. Nothing here is an argument that the strategy works. It is
an argument that the charter deserves to be read in full before its gate is rewritten.
