# Phase 3 requirements-to-implementation matrix

Status values: `implemented`, `tested`, `deferred`, `blocked`, `not applicable`. A row is not `tested` from
inspection alone; evidence names the file, test, or command.

**Read this first.** This PR delivers the **entire provider-agnostic analyst pipeline and its safety surface**,
tested with a deterministic stub adapter. It deliberately does **not** wire a real model provider. That is not
an oversight: adding the Anthropic SDK means loosening a permanent CI safety gate (`live-disabled.test.ts`
forbids the SDK and `api.anthropic.com`) and adding a POST egress path (`data/http.ts` is policy-forbidden from
issuing a POST today), and the Phase 3 exit criteria are about pipeline safety, which is entirely provider-
agnostic. The real provider, the egress change, and the live capability re-verification (CR-11 to CR-13) are a
focused follow-up PR that needs an API key and a review of the egress change. This is the same pattern Phases
0-2 used: build the machinery against a synthetic adapter, defer the live integration.

## Deliverables (PLAN.md Phase 3)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Sealed evidence packet builder from `asOf` reads only | tested | `packages/core/src/research/packet.ts`; `research-packet.test.ts` (7) — future-date and processing-delay exclusion, provenance, guard |
| 2 | Public-source allowlist | tested | The packet is built only from point-in-time observations of allowlisted sources; the model receives no network and no tools. Production retrieval stays confined to the existing egress allowlist (`data/http.ts`) |
| 3 | `ModelAdapter`, pinned ids from config, structured output, local schema validation, citation verification, bounded retries, deadline, circuit breaker, abstention | tested (machinery); deferred (real provider) | `model/adapter.ts`, `model/assess.ts`, `model/manifest.ts`, `research/assessment.ts`; `model-assess.test.ts` (9), `model-manifest.test.ts` (6), `research-assessment.test.ts` (13). The real Anthropic implementation + provider-side structured output is **deferred** to the follow-up PR |
| 4 | Prompt-injection defenses and adversarial fixture suite | tested | `research/packet.ts` untrusted-source notice + no-tools by construction; `model-adversarial.test.ts` (9) covers all 8 spec fixtures |
| 5 | Per-call/day/month budgets | tested (enforcement); deferred (persistence) | `runAssessment` refuses when day/month spend is exhausted and never charges risk/reconciliation; config `budgets` fields exist. Persisting spend across process restarts is **deferred** to runtime wiring (Phase 5) |
| 6 | Prompt caching measurement | deferred | Needs a real provider to measure a hit rate; the manifest records `promptCaching` support per model. Follow-up PR |
| 7 | Synchronized B0/B1/C1/D1 recording | tested (primitives); deferred (backtest wiring) | `model/overlay.ts` enforces non-interaction by type and stamps contamination; `model-overlay.test.ts` (7). Wiring C1/D1 into `runBacktest` is **deferred** — a real C1/D1 run is prospective (Phase 5 shadow), per `docs/AUTOMATION_AND_LIVE_GATES.md` |
| 8 | Contamination labels on any historical replay | tested | `HISTORICAL_REPLAY_CONTAMINATED` via `labelsForMode`; `model-overlay.test.ts` |
| 9 | Locked prospective ablation plan | implemented | `docs/PHASE3_ABLATION_PLAN.md` (locked design). Formal registration in the experiment registry waits until a charter declares an LLM rule |

## Exit criteria (PLAN.md Phase 3)

| Criterion | Status | Evidence |
|---|---|---|
| Adversarial content cannot cause a tool call, secret disclosure, config change, or an executable order | tested | Model has no tools by construction; `test/policy/no-llm-in-sizing.test.ts` (T-05 gate) proves no assessment/model field reaches sizing and the model layer forms no order and reads no env; packet guard refuses secrets; `model-adversarial.test.ts` |
| Invalid, late, or uncited responses abstain safely | tested | `runAssessment` abstains on schema/citation/factor failure, deadline, unavailability, silent model swap, and over-budget; `model-assess.test.ts`, `model-adversarial.test.ts` |
| Every input/output/version/cost is archived and redacted | tested (record + redaction); deferred (persistence) | `ModelCallRecord` captures model id, prompt/schema/packet hashes, tokens, cost, latency, validation, outcome; the packet is redaction-guarded. Writing the record to the ledger/store is **deferred** to runtime wiring |
| Historical results carry contamination labels | tested | `model-overlay.test.ts` |
| The ablation plan is registered | implemented (locked) | `docs/PHASE3_ABLATION_PLAN.md`; registry registration deferred until a charter declares an LLM rule |
| No claim that the LLM is useful is made from memo quality | tested (by construction) | The ablation plan makes the paired C1−B1 after-cost difference the only evidence; memo quality is explicitly excluded |

## What remains in the phase, and why it is deferred rather than missing

- **The real Anthropic adapter + egress change + CR-11/12/13 re-verification.** Needs an API key and a review
  of the POST egress change to a safety-gated boundary. Own follow-up PR.
- **Persistence of the model-call record and the running budget** to the ledger/store. Belongs with the
  runtime wiring that Phase 5 (shadow operation) builds; recording a call means a real call.
- **Wiring C1/D1 into the backtest/decision loop.** A real C1/D1 run is prospective by protocol (Phase 5
  shadow); a historical wiring would only ever produce contaminated diagnostics.

None of these can be honestly marked `tested` now: two need credentials or a real call, and one is a later
phase by the protocol's own design. The safety surface — the part that must hold before a model is ever
called — is complete and tested.
