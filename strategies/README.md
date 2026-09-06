# Strategies

This directory holds one subdirectory per strategy. Each contains a versioned `ALPHA_CHARTER.md` and, once registered, a machine-readable companion `charter.yaml` whose fields mirror the charter and whose hash is recorded in the experiment registry.

## What an Alpha Charter is

An Alpha Charter is the complete, frozen statement of one investment hypothesis before any result is looked at. It states the universe and how membership is known on each decision date, the mechanism and why it could persist, every input with its observation and availability time, the exact decision rule and timestamps, deterministic sizing, costs, benchmarks, one primary metric, the evaluation splits and minimum observation counts, the fixed parameter grid and trial count, the falsifiers, the promotion and sunset rules, and whether a runtime LLM is involved and how its value must be proven. The required contents are listed in `docs/EXPERIMENT_PROTOCOL.md`. A charter that cannot name its mechanism, point-in-time data, horizon, benchmark and falsifier is deferred, not registered.

Deterministic code owns every number and every hard boundary. An LLM contribution, where one exists, is a structured field mapped to a rule by code; it is never an order and never a size. "An LLM reads public information and finds good stocks" is not a hypothesis and will not be registered.

## Approval workflow

| State | Meaning |
|---|---|
| `DRAFT` | Written, marked "not approved; do not implement". Numbers are proposals. Anyone may comment. Nothing is built. |
| `REGISTERED` | Owner has signed the approval block. Charter hash, code commit, data snapshot IDs, parameter grid, trial count, splits and pass/fail criteria are frozen in the experiment registry. The final holdout is sealed. Implementation of the research may begin. |
| `ACTIVE` | The registered research completed and the owner accepted the result in writing. The strategy runs in `SHADOW`, then `PAPER`, then live modes only through the gates in `docs/AUTOMATION_AND_LIVE_GATES.md`. A failed result goes to `REJECTED`, never to `ACTIVE`. |
| `PAUSED` | A falsifier, data or model outage, incident, or owner request stopped new risk. Existing positions exit by the charter's own rules (`HOLD_ONLY`). Parameters are not touched while paused. |
| `SUNSET` | Retired by rejection, repeated pause, or owner decision. Positions unwound by rule. All records retained. |

Promotion is never automatic. Demotion can be.

## Material change is a new version

Once results have been viewed, any change to the universe, a rule, a parameter, a data transformation, the cost model, the benchmark, the metric, the model snapshot, the prompt, the schema or the ontology is a new charter version that starts again at `DRAFT` and a new experiment in the registry. Old results are never overwritten. Underperformance over a short window is not a reason to change anything outside a registered research cycle.

## Current charters

| Strategy | Kind | Status |
|---|---|---|
| `etf-trend-vol/` | Deterministic trend and volatility control over a frozen liquid ETF list | DRAFT |
| `form4-insider-cluster/` | Deterministic Form 4 open-market purchase clusters; optional bounded LLM extraction as a C1 feature | DRAFT; stock-level promotion blocked pending point-in-time universe coverage |
| `filing-change-challenger/` | LLM filing-change extractor evaluated only as a C1 overlay on a host | DRAFT; challenger feature, not a strategy |

## Recommended build order

Build `etf-trend-vol` first. It has no survivorship problem, no filing parser and no LLM, so it exercises the point-in-time store, total-return ledger, simulator, benchmark engine, experiment registry and shadow ledger on the cleanest possible data, and it tests a real hypothesis whose honest failure would still be a useful result. Build `form4-insider-cluster` second, and only once point-in-time membership and delisting coverage exist, either from an approved paid source or from Black Gold's own daily universe snapshots collected over a long enough prospective window; until then any historical result it produces is labelled exploratory and cannot support promotion. Treat `filing-change-challenger` as a Phase 3 experiment, not a strategy: it runs only as a C1 arm on a host that has already completed Phase 2, its historical replay is contaminated by construction, and its most likely outcome is a documented finding that the runtime LLM adds no measurable value in this role. That finding is acceptable and should be recorded rather than argued around.
