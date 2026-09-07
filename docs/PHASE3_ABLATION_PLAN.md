# Phase 3 — Locked prospective LLM ablation plan

**Status:** Locked design, 2026-09-07. This plan is preregistered: it is written before any prospective LLM
observation exists, and it fixes how the runtime LLM's contribution will be judged. Changing any element
below after a result is viewed is a new experiment version (`docs/EXPERIMENT_PROTOCOL.md` section 3), not an
edit. Nothing here is promotion evidence, and nothing here may be executed as a live signal; C1 becomes
eligible only on prospective evidence at a later phase, and only Matt opens a holdout or signs a promotion.

## What is being tested

Whether the bounded runtime-LLM overlay (`C1_LLM_OVERLAY`) adds robust, after-cost value over the identical
deterministic strategy without it (`B1_DETERMINISTIC`). The overlay is strictly subtractive by construction
(`packages/core/src/model/overlay.ts`): C1 can only remove a name B1 selected, never add one, so the test is
whether *removing* names on the model's signal improves the paired outcome.

## The primary test (preregistered)

- **Statistic:** the paired difference `C1 − B1` in the charter's primary metric, per rebalance period, on the
  same candidates, timestamps, portfolio and risk rules, and execution assumptions. C1 receives B1's frozen
  candidate list as input and applies only its preregistered rule (non-interaction, protocol section 6.1).
- **Interval:** a block bootstrap over the paired period differences, block length set by the charter, to
  respect serial correlation.
- **Decision:** the LLM arm is included in the production signal only if the paired difference is positive
  after costs with an interval excluding zero at the charter's preregistered level. If it does not clear that
  bar, the runtime LLM is **excluded** from the production signal. Beating the passive benchmark (B0) while
  failing to beat B1 means the LLM added nothing; **B0 is not the primary comparator.**
- **Costs:** every C1 decision carries the same cost, delay, and missing-data tiers as B1, plus its own model
  call cost. A value claim is after all of these.

## Evidence that counts, and evidence that does not

- **Prospective only.** The observation packet is sealed and the model output is recorded and hashed *before*
  the outcome is knowable; the outcome is joined later by deterministic code. Only these paired, timestamp-
  locked observations count toward the primary test.
- **Historical replay is contaminated.** Any run in which the current model scores evidence from before its
  training cutoff carries `HISTORICAL_REPLAY_CONTAMINATED` on every row, plot, and report page. Contaminated
  runs may diagnose *mechanics* — schema compliance, abstention rate, citation verification, injection
  resistance, latency, cost — but are never primary alpha evidence and promote nothing.
- **Memo quality is not evidence.** Plausibility, citation quality, and a well-argued thesis do not count.
  Only the paired after-cost difference does.

## Observation target and boundaries

- **Observation count:** the charter's preregistered prospective observation count for an LLM arm. Until a
  charter declares an LLM rule and its count, no C1 evaluation is registrable. (`etf-trend-vol` currently
  declares no LLM in the signal.)
- **Holdout:** untouched by this plan. The once-only holdout opens after Matt reviews the design and
  walk-forward results and writes a reason, through `ExperimentRegistry.openHoldout`. Claude Code may not open
  it or cite any run as promotion evidence.
- **Degradation is recorded, not hidden.** When the model is unavailable, slow, over budget, or returns
  invalid output, C1 abstains and degrades to B1; the ledger records the degrade so the ablation stays honest
  (T-07).

## What locking this plan does not do

It registers no experiment, computes no result, and authorizes no live LLM arm. It fixes the rules of judgment
so that when a charter later declares an LLM rule and prospective observations accrue, the test cannot be
chosen after seeing the data. Registration of a concrete C1 experiment, and any promotion, remain the owner's
acts.
