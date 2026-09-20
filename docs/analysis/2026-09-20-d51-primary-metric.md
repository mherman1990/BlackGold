# D-51: the metric question is premature, because the decisive falsifier has never been evaluated

**Status:** analysis for the owner. It decides nothing. Changing a promotion metric is a charter edit and
therefore a new strategy version, which is the owner's act (`CLAUDE.md`, "What standing authorization never
covers").

D-51 asks whether `net_sharpe_difference_vs_primary_benchmark` is the right *primary* promotion metric for a
strategy whose stated thesis is drawdown reduction. Reading the charter and the code against each other
changes the question. The short version:

0. **Every primary-metric number below is superseded (2026-09-20).** The code computed an INFORMATION RATIO
   under the registered metric's name; §13 registers a **difference of Sharpe ratios**. The −0.19 quoted
   throughout this note is therefore an information ratio, not the primary metric. Fixed in PR #94 (§2f);
   the corrected statistic has not been run on real data, so the direction of the change is unknown.
1. The charter **already** values drawdown, in two places D-51 does not mention.
2. The charter's **decisive** falsifier is a conjunction, and only one half of it has ever been computed.
3. `research evaluate` — the command that produced the evidence — **dropped every number except the primary
   metric**, which is why nobody noticed either fact.
4. So "the strategy fails its own gate" is wrong twice over. The DESIGN primary-metric number is a
   **per-window diagnostic, not an F1 verdict** — §13 defines the pass rule "on the aggregate walk-forward
   out-of-sample set", and DESIGN is in-sample (§2c). And §16.1's status is not merely unknown.
5. §16.1 could not be computed at all, because the benchmark it names — Secondary 2 — was not implemented
   (§2a). (Both this and the point above were found by Codex review of earlier drafts of this note, not by
   the drafts themselves.) **Secondary 2 is now built — see §2d — so the prong is computable; it has still
   not been run on real data.**
6. **And the verdict now exists at the scope the charter defines it (§2e).** `research evaluate` emits one
   §16.1 outcome over the walk-forward splits pooled, with the prongs withheld rather than guessed whenever
   the pool or either comparator is incomplete. The title of this note still stands: the falsifier has
   machinery and has **not** been evaluated on real data.

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

## 2d. Secondary 2 is now implemented (2026-09-20)

Built to mirror §9.5 with the holding set reduced to the primary alone:

- **Estimator.** `sigma_primary` is read from the very `computeFeatures` covariance window the strategy sizes
  with — the annualized 63-session sample covariance of log total-return returns. It is the charter's "same
  63-day estimator" literally, not a second implementation, so the two cannot drift apart.
- **Scale factor.** `k = min(1, annual_volatility_target / sigma_primary)`, matching `constructTargets`
  exactly, including leaving `k = 1` when sigma is zero. Remainder in BIL. Long-only and unlevered by the cap.
- **Timing.** The weight takes effect `execution_delay_bars` sessions after the decision, where the
  strategy's own fills land, and holds until the next decision takes effect. This matters: `blendSeries`
  multiplies the weight by session *t*'s own return, so applying it at the decision session would let a
  volatility estimated through that session's close earn that session's return. A test asserts the weight
  changes **only** at `decision session + delay`.
- **Availability.** Empty when the primary is not among the charter's risk ETFs, because `computeFeatures`
  then produces no volatility for it. In that case §16.1's prong reports `undefined` and **nothing is
  substituted** — a test pins that the average-exposure approximation is never promoted into its place.

`evaluateFalsifiers` now takes `primaryVersusSecondary2` and decides `decisiveRejection` from the registered
comparator. That closes the latent defect recorded below: it previously decided rejection from the
approximation.

**The fill-timing problem, and how it was finally fixed.** The first implementation fed a per-session weight
into `blendSeries`, and Codex took four rounds to dismantle it. Each round refuted the justification given in
the round before:

1. *"`EXPOSURE_MATCHED` sets the precedent."* — §11 defines Secondary 1 as a calendar-month **ex-post**
   average; the code uses a per-session weight, so it is not the registered benchmark either.
2. *"An exact treatment is not expressible in the series model."* — it is: `runBacktest` already loads raw
   opens for both legs.
3. *Withhold the prong instead.* — `evaluateFalsifiers` treated an absent prong as "does not beat", so
   withholding would have emitted a §16.1 rejection on **every** run whose primary metric failed. And the
   published series let anyone rebuild the withheld number by subtracting two fields.

The owner's call after round four was to **stop patching and build it properly**, which was right: every
defect above traced to one mismatch — `blendSeries` applies a single weight to a whole close-to-close return,
and Secondary 2 needs a weight that changes intraday.

**`volatilityTargetedSeries` (`research/benchmarks.ts`) builds Secondary 2 as its own index.** The rebalance
session is split at the open: the **old** weight earns `prevClose → open`, the **new** weight earns
`open → close` — exactly where `simulateFill` acquires the strategy's position. Two consequences:

- **The pre-fill gap is gone.** The new weight no longer earns an overnight move its position did not exist
  for.
- **The common-session stretch stops mattering.** Whatever interval precedes the open — one session or five —
  the old weight earns it, which is correct, because the new position did not exist for any of it. The fix
  for the second defect fell out of the fix for the first.

The split preserves the session's total return exactly: the distribution rides the overnight leg and the
intraday leg carries it through, so the two multiply back to the index's own step. Only rebalance sessions are
decomposed; everywhere else the index steps by the plain blended close-to-close return.

Fail-closed where it cannot be done: if a rebalance session has no usable open on either leg, the **old**
weight earns the whole session and a warning is recorded — under-crediting the new position rather than
handing it a move it did not earn.

With the timing exact, **the prong is restored**: `primaryVersusSecondary2` is published again, and the
`__TIMING_BIASED` suffix that labelled the interim series is gone. `evaluateFalsifiers` keeps the corrected
three-state `decisiveRejection`, because "unmeasured" and "failed" remain different things.

A bug the new unit tests caught immediately, worth recording because it is the kind the previous approach hid:
an activation on the **first** session was silently ignored, since the loop starts at the second, so the whole
series would have run at zero weight.

**One charter ambiguity this forced into the open, and an owner call.****One charter ambiguity this forced into the open, and an owner call.** §11 does not state a re-scaling
cadence. The implementation re-scales **weekly, at the strategy's decision instants**, chosen so that
everything except selection matches the strategy and the comparison isolates what §11 says it isolates. The
literal alternative — re-scaling every session — is defensible and would give a different number. This is the
same shape as D-32: Claude Code implemented a reading, and the owner should confirm or overrule it before the
number is treated as decisive. It is not a code question.

## 2e. Step 2: §16.1 is now evaluated once, at the scope the charter defines (2026-09-20)

`packages/core/src/research/aggregate.ts` supplies the missing scope. `runEvaluation` collects each
walk-forward split's Sharpe input legs and its arm/benchmark total returns while the backtest and its report
are both in hand, and `aggregateWalkForward` returns one verdict under `EvaluationReport.aggregate`:
`REJECT`, `OWNER_REVIEW`, or `UNMEASURED`. §2b still holds — there is no per-split §16.1 outcome and none was
added.

**How the two prongs are pooled.** *(This table described the superseded statistic until Codex caught it on
review; §2f corrected the code and left the section that documents the code saying the old thing — which is
exactly how a future reconstruction gets steered back to it.)*

| Prong | Pooled how |
|---|---|
| §16.1 first / §13 primary metric | `sharpeInputSeries` (exported from `report.ts`, called by both scopes) yields **two** legs per session — the candidate's and the primary benchmark's daily excess return over the **cash** leg, on the sessions all three share. The aggregate concatenates **both** legs across splits in session order and runs `stationaryBootstrapPaired` once, with `annualizedSharpeDifference` as the statistic: one draw of block indices applied to both legs, so the strategy stays paired with the benchmark session by session. It is a **difference of Sharpe ratios**, not the Sharpe of a difference — see §2f. Pooling the *input* rather than averaging per-split *results* is what makes this the same statistic at a wider scope instead of a second statistic that resembles it. |
| §16.1 second / §13 excess return vs Secondary 2 | Each window is backtested **from cash**, so the per-split total returns are **chain-linked** — `Π(1 + r) - 1` — for the candidate and for Secondary 2 independently, and the excess is the difference of the two linked returns. Summing instead of linking is wrong by more than rounding over nine windows, and the error does not cancel between the strategy and its comparator. |

**Four fail-closed rules, each there to stop a rejection being manufactured rather than measured.**

1. **Walk-forward splits only.** A DESIGN or RECENT split passed to the aggregate throws. DESIGN is in-sample
   (§14.1); pooling it would state an out-of-sample verdict over data that is not out of sample.
2. **The pool must be the whole schedule.** A run narrowed with `--split` yields `UNMEASURED`, never a
   verdict. Otherwise the same charter would reject or not depending on which windows the operator chose to
   run — window-shopping with extra steps. **Both** outcomes are withheld from a partial pool, not just the
   rejection, because "goes to owner review" is equally a claim about a set that was not measured.
3. **Both prongs must be measured.** One split without a usable Secondary 2 (not built, or built inexactly and
   therefore withheld) leaves the aggregate prong `undefined`. Nothing is substituted, and absence is not
   failure — §16.1 rejects "if both fail". The lookup is by the unqualified benchmark name, so an index
   published as `SECONDARY_2_VOL_TARGET_PRIMARY__INEXACT` cannot enter the chain-link.
4. **A short series is not padded.** `buildResultReport` pads a two-observation series with `[0, 0]` to keep
   the per-split *diagnostic* shaped correctly. A decisive verdict may not rest on a fabricated interval, so
   the aggregate reports `primaryMetric: undefined` instead.

**The §16.1 / §17 contradiction is detected and surfaced, not resolved.** When the primary metric fails and
Secondary 2 passes, the verdict is `OWNER_REVIEW` per §16.1 and `charterConflict` states §17's competing rule
("REJECTED, never to ACTIVE") in full. §6 below has been dormant since it was written; this is the code that
makes it fire the moment the case occurs.

**Three limits the verdict carries in `evidenceCaveats`.** All are stated rather than corrected, and the first
two bias in a direction worth naming.

1. **The registered deflated-Sharpe adjustment is not applied.** §13 registers one "for the registered trial
   count (§15)". `deflatedSharpe` exists in `stats.ts` but needs the cross-trial Sharpe dispersion of the full
   72-member grid, which one evaluation run does not produce. Deflation can only lower a Sharpe, so the prong
   as computed is **easier** to pass than the registered statistic — the omission biases §16.1 toward owner
   review and away from rejection. That is the safe direction for a falsifier, and it is still not the
   registered statistic. Wiring it is F5's grid sweep.
2. **Each window restarts from cash.** At each boundary the strategy sits flat until its first fill while the
   benchmark is fully invested, so the pooled excess carries a warm-up drag and a round of re-entry cost a
   continuously-held portfolio would not pay. Bootstrap blocks drawn from the concatenation can also straddle
   a boundary. Concatenation is §13's literal reading; a within-split bootstrap would be an unregistered
   estimator.
3. **The schedule cannot reach the charter's own minimum independent-decision count.** §14.3 requires **150**
   monthly-equivalent out-of-sample blocks. `splitPlan` on charter 0.2.0 produces **9** walk-forward splits
   tiling **2010-06-28 → 2018-12-31** — about 2,150 sessions, so roughly **102** blocks. §14.3's "155 in
   design, 72 in holdout" counts the design window and the sealed holdout, neither of which is the
   walk-forward out-of-sample set, and nothing in §14 reconciles the two. §16.1 states no such precondition,
   so the verdict is computed and `minimumIndependentDecisionsMet` reports the shortfall. **Either the
   schedule or the minimum is wrong for this charter; both are charter values and therefore the owner's.**

Both of Secondary 2's open owner readings — the weekly re-scaling cadence (§2d) and the ex-date reinvestment
convention — are attached to any verdict resting on the second prong. **Until the owner confirms or overrules
them, a §16.1 rejection from this code is provisional.**

**On the tests.** Nine vacuous tests across PRs #91-#93 shared one shape: fixtures uniform in the dimension
the code branches on. Every guard above was checked by deleting or inverting it and confirming a test fails —
sixteen mutations, no survivors. The chain-link fixture is the clearest case: candidate +50%/+50% against
Secondary 2 +100%/+10% gives excess **+0.05 linked** and **−0.10 summed**, so a summing implementation rejects
the hypothesis exactly where a linking one routes it to owner review.

**What is still not done.** None of this has been run on real data — that needs the Pi's store, and the runs
there remain `UNVERIFIED_SINGLE_SOURCE` until reconciled corporate actions are curated. Step 3, the metric
question itself, is unchanged and is the owner's.

## 2f. The primary metric was the wrong statistic, and an unadjusted pass was being published (2026-09-20)

Both found by Codex on PR #94, both fixed there. The first invalidates every primary-metric number in this
note.

### The metric was an information ratio

§13: *"difference in after-cost annualized **Sharpe ratio** between the strategy and VTI total return"*. The
registered id is `net_sharpe_difference_vs_primary_benchmark`. What the code bootstrapped was:

```ts
annualizedSharpe(candidateReturns - benchmarkReturns)   // the Sharpe of the difference
```

which is the **information ratio**, not the difference of Sharpe ratios. The repository states this itself,
in the module the report imports from:

```ts
// packages/core/src/research/benchmarks.ts
export function informationRatio(strategy, benchmark) { return sharpe(strategy, benchmark); }
```

`sharpe(a, b)` is `mean(a − b) / sd(a − b)`, annualized — the same construction. So `armMetrics` was already
publishing this very number as `informationRatioVsPrimary`, correctly named, right beside the promotion gate
that was the same number. **One statistic, two names, one of them wrong, and nothing in the test suite
noticed** — the report tests pinned the interval's shape and the threshold, never the statistic.

| | Formula | What it measures |
|---|---|---|
| **Registered (§13)** | `Sharpe(strategy) − Sharpe(VTI)`, each in excess of cash | Does the strategy have a better risk-adjusted return than VTI? |
| **What ran until 2026-09-20** | `Sharpe(strategy − VTI)` | Does the strategy beat VTI consistently, relative to tracking error? |

They disagree in magnitude and in **sign** whenever the legs differ in volatility or are imperfectly
correlated — which is the whole premise of a volatility-targeted strategy. A low-volatility strategy that
tracks VTI closely can post a strong information ratio and a negative Sharpe difference, or the reverse.

**The fix.** Both legs are now taken in excess of the cash leg (a Sharpe ratio is against the risk-free leg,
which `armMetrics.sharpeVsCash` already used), their Sharpe ratios are computed separately, and the
difference is bootstrapped with `stationaryBootstrapPaired`: **one** draw of block indices applied to both
legs, so session *t* of the strategy stays paired with session *t* of the benchmark. Breaking the pairing
would report the interval of two independent arms, which the protocol forbids. `REPORT_VERSION` 4 → 5,
because a v4 point estimate and a v5 one are different statistics and must never be compared.

**This note's −0.19 was an information ratio.** So were the numbers in the 2026-09-13 machinery check. The
corrected statistic has not been run on anything but synthetic fixtures, so **which way it moves is
unknown**, and was unknown when the fix was made. That ordering is what separates this from metric-shopping:
it implements the metric the charter registered, exactly as the Secondary 2 work did, rather than selecting
one after seeing a result.

### An undeflated pass was being published as a pass

§13's metric also carries "a deflated-Sharpe adjustment for the registered trial count (§15)", and §15 is
concrete: *"Deflated Sharpe ratio is computed with N = 72 trials and the observed cross-trial variance."* One
evaluation run produces neither, so the adjustment is not applied. The first version of the aggregate
recorded that in `evidenceCaveats` and still emitted `passes: true` — leaving a consumer free to act on a
concrete verdict the missing adjustment might reverse. That is the Secondary 2 gate's first failure again: a
warning that depends on being read, guarding a number that does not depend on being read.

The prong is now **tri-state**, and the asymmetry is the substance:

- **`false`** when the threshold test fails. Sound without the adjustment: §15 computes the deflated Sharpe
  against the expected maximum over 72 trials, and under either reading of how it enters the pass rule (an
  extra test, or a deflated estimate substituted into the threshold) it can only ever *add* a hurdle. A
  failure stays a failure once the grid statistics exist, so §16.1 may act on it and **REJECT stays
  reachable** — which matters, since REJECT is the outcome that does not flatter the strategy.
- **`undefined`** when the threshold test clears. An undeflated pass is not a registered pass.
- **`true`** unreachable until F5's grid sweep wires the adjustment.

§16.1 is correspondingly evaluated in **three-valued logic**: either prong passing gives owner review
(determinate even when the other prong is unknown, because §16.1 asks only whether *either* passed); both
prongs known to have failed gives rejection; anything else is undetermined. Collapsing unknown into either
branch is the error this thread keeps rediscovering — it is the same mistake as treating an absent Secondary 2
as "does not beat".

### What the tests learned

Nine mutations against the new guards, no survivors — but **two survived the first pass**, and both were
tests proving something other than what they claimed:

- The paired-bootstrap test compared the result against `stationaryBootstrapPaired` itself, so mutating the
  function mutated the reference too. Replaced with an invariant that cannot be self-satisfied: resample a
  series against **itself** under a statistic that is identically zero on equal inputs. A shared draw makes
  every resample see `sampleA === sampleB`, so the interval collapses to exactly `[0, 0]`; independent draws
  open it up. Nothing but the shared draw produces a degenerate interval.
- The hash test's two fixtures differed in the *second* prong as well as the first, so it passed against a
  hashed body with the tri-state stripped out. Replaced with two runs that differ **only** in the threshold —
  identical point estimate, interval, second prong and verdict — one of which is the §16.1/§17 conflict case
  and one of which is not.

One more fixture defect surfaced on the way: `research-report.test.ts` built its benchmark and cash series
with **constant** per-session growth, i.e. zero volatility, which makes every Sharpe taken against them
degenerate and every assertion about a Sharpe difference vacuous. The benchmark now carries deterministic
jitter. Same shape as the nine vacuous tests of PRs #91-#93: a fixture uniform in the dimension the code
branches on.

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

**Step 1 — implement the registered Secondary 2.** ~~Outstanding.~~ **Done** — see §2d for how, and for the
one charter ambiguity it forced into the open.

**Step 2 — evaluate §16.1 over the aggregate walk-forward set**, not per split. ~~Outstanding.~~ **Done —
see §2e.**

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
