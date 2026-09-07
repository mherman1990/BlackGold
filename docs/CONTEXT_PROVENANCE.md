# Context provenance

This document records what external context was used to produce the Black Gold Discovery Pack and confirms that no other application's product details became requirements.

## Inputs actually received

| Input | Used for | Product details imported |
|---|---|---|
| `TILLER_REVIEW_AND_CLAUDE_CODE_PROMPT_V3.md` (prepared 2026-09-06, supplied by Matt) | The authoritative product prompt. Section G is the specification; Sections A–F and H are the review that produced it. Rebranded from Tiller to Black Gold at Matt's instruction. | All. This is the product spec by design. |
| Matt's instruction in this session | Repository choice (`mherman1990/BlackGold`, already created, public) and the rebrand. | Repository identity and name. |
| Matt's standing preferences (user profile) | Free government data first; self-hosted Pi/Umbrel fleet; adapter architecture; model tiering (Haiku triage, Sonnet synthesis, Opus flagship); cost awareness. | Used to shape the runtime-model recommendation in D-11 and the resource budget. They are preferences, not decisions, until recorded in `docs/DECISIONS.md`. |
| First-party documentation fetched 2026-09-06 | Capability register entries. See `docs/CAPABILITY_REGISTER.md` for URLs and access dates. | Facts only. |

## The "external-agent document" referenced by the review

Section A of the review refers to an "attached external-agent document" describing how Matt worked with another coding agent on a different application. **That document was not attached to this session.** Nothing from it was available, so nothing from it was used. The context-use firewall in Section G §0 was therefore trivially satisfied.

The review itself lists the generic workflow lessons it took from that document: locate the authoritative checkout, read state/handoff documentation, protect concurrent work, stage exact files, test before shipping, keep mutable state outside images, synchronize release metadata, verify multi-architecture publication, and leave a durable handoff. Those lessons are adopted here as Black Gold practice because the review adopted them, not because any other app's files were read.

## Confirmation

- No repository path, source tree, app/store/image/container id, port, data directory, version, tag convention, source adapter, model workaround, module layout, issue list, audience, customer, domain requirement, compliance language, schedule, host, or restriction from any other application appears in this repository.
- The only prior product name that appears anywhere is "Tiller", and it appears only in this file and in `docs/DECISIONS.md` D-01 to record the rebrand. The identity check in `docs/IDENTITY.md` fails CI if it appears elsewhere.
- The restricted-theme seed in `docs/DECISIONS.md` D-14 derives from Matt's stated professional role, not from any other application's compliance list.

## What to do if the external-agent document is supplied later

Read it for workflow lessons only. Do not copy identifiers, paths, ports, adapters, or requirements. Record in this file which lessons were taken and confirm again that no product details crossed over.
