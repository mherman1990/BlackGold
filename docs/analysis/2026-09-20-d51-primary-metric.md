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
4. So "the strategy fails its own gate" is imprecise. It fails **F1**. Whether §16.1 rejects it is **unknown**.

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

The code implements this correctly:

```ts
// packages/core/src/research/robustness.ts
const beatsPrimary = m.primaryPointEstimate >= threshold && !outcomes.some((o) => o.id === "F1" && o.triggered);
const beatsVolControlled = m.primaryVersusVolatilityControlled !== undefined && m.primaryVersusVolatilityControlled > 0;
…
decisiveRejection: !beatsPrimary && !beatsVolControlled,
```

`buildResultReport` computes `primaryVersusVolatilityControlled` on every run. **The 2026-09-13 note does not
mention it, and could not have**: `runEvaluation` — the function behind `research evaluate` — surfaced only
`primaryMetric` and a two-field arm summary. Calmar, CAGR, the benchmark metrics, F2's inputs and the whole
second prong were computed and discarded before the operator saw them.

That is the root cause of D-51 being framed the way it was.

## 3. What this means for the claim "it fails its own gate"

It fails **F1**: primary −0.19 against a +0.10 threshold, CI straddling zero, on DESIGN. That is real and it is
in-sample, which makes it worse rather than better.

It does **not** establish §16.1 rejection. Under §16.1 the strategy is rejected only if it *also* fails to beat
Secondary 2. If it beats Secondary 2, the charter says **owner review**, not rejection. Nobody has that number.

There is therefore a cheap, uncontaminated, preregistered measurement standing between the current state and
any decision about metrics.

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

**Do this first, and it needs no charter change and no decision:**

Re-run the evaluation on the Pi with the reporting fix in this PR, and read the numbers the charter already
asked for:

```
node packages/core/dist/main.js research evaluate \
  --path strategies/etf-trend-vol/charter.yaml \
  --source tiingo.eod.bars.1d --split design
```

The output now carries, per split: `primaryVersusVolatilityControlled` (§16.1's second prong),
`decisiveRejection` with its reasoning, `drawdown` (F2 with its ratio), and `arms`/`benchmarks` with CAGR,
Calmar and max drawdown (§13). Runs stay non-evidential while the data carries
`UNVERIFIED_SINGLE_SOURCE`; these are diagnostics, not promotion evidence.

**Then D-51 splits into two genuinely different questions, and which one you are answering depends on that
output:**

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

**Does:** surfaces §13's secondary metrics and §16.1's second prong through `research evaluate`, computes F2,
and reports which falsifiers a single run actually evaluated (F1 and F2) rather than leaving the rest to be
assumed. It also declines to call a missing second prong a rejection — `decisiveRejection` is `undefined`,
not `true`, when Secondary 2 was not computed, because "not measured" and "failed" are different findings and
§16.1 turns on the difference.

**Does not:** change any metric, threshold, falsifier, or charter value; change the taint or dedupe rules;
compute the real number (that needs the Pi's store); or decide D-51.

Worth stating plainly: the underlying situation is unchanged and may still be bad. The strategy failed F1
in-sample, and RECENT looks poor on both F1 and F2. Nothing here is an argument that the strategy works. It is
an argument that the charter deserves to be read in full before its gate is rewritten.
