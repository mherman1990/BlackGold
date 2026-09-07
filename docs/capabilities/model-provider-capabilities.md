# Model provider capability register

The runtime LLM is a product decision (D-11), separate from Claude Code being the development agent. This register records what is known about the recommended provider and what must be checked at implementation.

## Anthropic (recommended initial provider)

### Verified 2026-09-06

| ID | Claim | Source |
|---|---|---|
| MP-01 | Message Batches: most batches complete within 1 hour; results available when all messages complete or after 24 hours, whichever first; batches expire at 24 hours; 50% price discount; results retained 29 days; limit 100,000 requests or 256 MB per batch | https://platform.claude.com/docs/en/build-with-claude/batch-processing |

### Partial (from the Claude Code bundled `claude-api` skill, cached 2026-06-24; confirm via Models API and docs at implementation)

| ID | Claim | Consequence |
|---|---|---|
| MP-02 | Current model IDs: `claude-haiku-4-5` (200K context, $1/$5 per MTok in/out), `claude-sonnet-5` (1M, $2/$10), `claude-opus-5` (1M, $5/$25). IDs are complete as written; no date suffix | Config stores these; never hardcode in source; pin per strategy version |
| MP-03 | Structured outputs via `output_config.format`; `strict: true` on tools; `client.messages.parse()` helper in SDKs | `ResearchAssessment` validation uses structured output plus local `zod` validation |
| MP-04 | Prompt caching via `cache_control` breakpoints; minimum cacheable prefix is model-dependent; verify with `usage.cache_read_input_tokens` | System prompt, ontology, and packet template go first and are frozen per strategy version; measure hit rate |
| MP-05 | Adaptive thinking (`thinking: {type: "adaptive"}`) on current models; effort via `output_config.effort` | Extraction runs at `low`/`medium` effort; registered experiments may test higher |
| MP-06 | Models API (`GET /v1/models`) returns `id`, `max_input_tokens`, `max_tokens`, `capabilities` | Config resolver validates pinned IDs at startup and fails closed on unknown IDs |
| MP-07 | Fable-tier models have different API behaviour and higher price; not needed here | Excluded from tiering |
| MP-08 | Data retention: standard 30-day retention applies; zero-data-retention terms are org-specific | Evidence packets contain public text only, so retention is acceptable; confirm terms |

### UNVERIFIED

| ID | Question | When |
|---|---|---|
| MP-09 | Current per-minute rate limits for Matt's API tier | Phase 3 |
| MP-10 | Exact structured-output failure modes (refusal, max_tokens) and their `stop_reason` values | Phase 3 adversarial tests |
| MP-11 | Typical p95 latency for a 20–40K token packet at `low` effort on Sonnet 5 | Phase 3 measurement; drives the post-close deadline |

## Selection criteria applied (D-11)

| Criterion | Weight | Assessment |
|---|---|---|
| Structured-output reliability with strict schema | High | First-party support (MP-03) |
| Quality on filing-comparison extraction | High | Expected strong; must be measured on a registered fixture set, not assumed |
| Latency under a synchronous post-close deadline | High | Unmeasured (MP-11) |
| Cost with caching and tiering | Medium | Haiku for extraction keeps per-candidate cost low; measured in Phase 3 |
| Data handling | Medium | Public text only; retention acceptable |
| Verifiability of batch/caching behaviour | Medium | Documented (MP-01, MP-04) |

## Adapter requirements

`ModelAdapter` exposes `assess(packet, schema, {modelId, promptVersion, deadline, budget})` and returns a validated object plus a `ModelCallRecord` (model id, prompt hash, schema hash, tokens, cost, latency, cache hits, validation result). Provider SDK types stay inside the adapter. A second provider adapter is not built unless a registered ablation requires it.

## Budget rules (proposed, see `docs/RESOURCE_BUDGET.md`)

Per-call, per-day, and per-month caps in config. Exceeding a cap stops new analysis and records an abstention; it never stops reconciliation or risk management.
