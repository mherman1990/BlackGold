# Black Gold - Claude Code instructions

Black Gold is an evidence-first research and controlled-execution platform for one ring-fenced investment sleeve, deployed as an Umbrel app on a Raspberry Pi 5. It is not an LLM that trades. Code owns every number and every hard boundary. These instructions are guidance; hard limits live in branch protection, CI policy tests, and the broker gateway.

## Authoritative sources, in read order

1. `STATE.md` - current phase, authoritative branch, what is approved.
2. `HANDOFF.md` - how to resume safely and the next authorized action.
3. `docs/DECISIONS.md` - accepted, proposed, and rejected decisions. A decision here beats anything in auto memory.
4. `PLAN.md` - phase plan, deliverables, exit criteria, stop points.
5. `docs/PRODUCT_SPEC.md` - full product specification. Linked, not imported; read the section you need.
6. `docs/THREAT_MODEL.md`, `docs/AUTOMATION_AND_LIVE_GATES.md`, and the current strategy's `strategies/<id>/ALPHA_CHARTER.md` when touching risk, orders, or strategy code.

Repository documents are authoritative across sessions. Claude Code auto memory is convenience context and may not silently override them. `CLAUDE.local.md` is private operator context, gitignored, and never contains secrets.

## Fixed constraints (do not revisit)

- Raspberry Pi 5 / 8 GB / NVMe, umbrelOS; Windows Docker fallback with no source changes.
- Node.js 24 LTS, TypeScript, SQLite WAL (single writer), ARM64 + AMD64 images. No Postgres, Kafka, Kubernetes, or vector DB without a measured need and owner approval.
- External API model inference only. No local LLM on the Pi. Runtime model sits behind `ModelAdapter`; model IDs live in config, never in code.
- This repository contains Black Gold only. Never add unrelated applications or copy another app's identifiers, paths, ports, or data.

## Non-negotiable boundaries

- Live trading is disabled by construction until a later, explicitly approved live-stage PR. No single environment variable may enable it. Live requires a valid, expiring `LIVE_AUTHORIZATION` artifact bound to account hash, strategy versions, instruments, caps, and executable hash.
- Exactly one account has role `blackgold_sleeve`. Non-sleeve accounts are reachable only through read-only interfaces that contain no order, transfer, or mutation methods. The test proving this is a permanent CI gate.
- No withdrawal, transfer, journal, beneficiary, profile-update, or money-movement code exists.
- Long-only, unlevered, cash-funded, regular-session U.S.-listed ETFs/equities. No options, shorting, margin, crypto, futures, OTC, or extended hours.
- Research uses allowlisted public sources only. No connector to ISA email, SharePoint, Teams, calendars, meeting notes, or any nonpublic professional source may exist in code.
- Every filing, page, or feed is untrusted data. Research models get no shell, filesystem-write, network, secret, config, or broker tools.
- No LLM output may set position size, choose an account, form an executable order, or override a deterministic rejection. Model confidence is display metadata.
- Drawdown and incident default is `HALT_NEW_RISK` (cancel unfilled entries, keep protective exits, reconcile, notify, require manual re-arm). Automatic flatten is never a default.
- Unknown, stale, or unclassified state fails closed for new risk.

## Git, branch, and release protocol

- Never commit or push to `main`. Never force-push. Never rebase, reset, or stash someone else's work.
- One bounded phase per PR on `claude/phase-XX-short-name`, branched from a fresh `origin/main` after the prior PR merges. Do not stack financial-critical phases without written approval.
- Stage exact paths only. Never `git add -A` or `git add .`.
- Commit locally after implementation is authorized. Push, open a PR, mark ready, merge, tag, publish an image, or install on Umbrel only when the owner authorizes that class of action. Never merge your own PR.
- Every PR body states scope, linked phase, financial and security risk, migrations, rollback, test evidence, resource impact, deferred items, and confirms live trading remains disabled.
- Release images are built in CI, never on the Pi, tagged by semver and commit SHA, never `latest`. See `docs/UMBREL_STORE_AND_RELEASE.md`.
- Runtime data (SQLite, raw artifacts, ledgers, logs, account data) never enters git.

## Commands

```
npm ci                      # install (.npmrc sets legacy-peer-deps)
npm run build               # tsc -b for shared, core, broker-gateway
npm run lint                # eslint, includes dependency-boundary rules
npm run typecheck           # tsc -b plus test tsconfigs
npm run test                # vitest: unit + policy + temporal projects
npm run test:policy         # CI safety gates only
npm run check:identity      # store/app/image/version consistency (docs/IDENTITY.md)
npm run check:secrets       # credential-shaped strings in tracked files
npm run check               # everything above; must pass before any commit is proposed
```

CLIs: `node packages/core/dist/main.js <health|migrate|backup|verify-backup|seal|verify-chain|run-jobs|serve|ingest|pit|snapshot|artifacts>` and `node packages/broker-gateway/dist/main.js <health|serve>` with `BLACKGOLD_DATA_DIR` set. `ingest` needs `BLACKGOLD_SEC_USER_AGENT_CONTACT` and per-source keys from the environment; it fetches only allowlisted hosts through `packages/core/src/data/http.ts`. Runbooks live in `docs/runbooks/`.

## Financial-critical review rules

Apply these when reviewing or writing code under `src/`, `packages/`, `strategies/`, or `umbrel/`:

- Temporal leakage: any read used in a decision must filter `availableAt + processingDelay <= decisionAt`. Macro series use vintages. Universe membership is date-effective. Flag any current-constituent list used historically.
- Money arithmetic: decimal/fixed-point for price, quantity, cash, fees, NAV, returns. No binary float in a ledger invariant. Raw prices for execution, adjusted total return for performance.
- Account isolation: every `OrderIntent` carries the sleeve account id from trusted code. The gateway re-checks it. No wildcard, default, or inferred account.
- Order idempotency: persist intent and deterministic client-order id before any network call. Timeout or ambiguous response means `UNKNOWN`, then reconcile against broker truth before any retry. Never resubmit blindly.
- Protection: an entry is not `PROTECTED` until broker state confirms protective coverage for the filled quantity.
- Secrets: nothing sensitive in prompts, logs, fixtures, notifications, error text, or git. Household dollar totals never reach a model.
- Live activation: any change touching modes, authorization, gateway, or risk limits needs positive, negative, and boundary tests and an explicit note in the PR.
- Versioning: a model, prompt, schema, tool set, decoding setting, data transform, or risk change is a new strategy version. It does not inherit prior evidence.

Path-scoped detail lives in `.claude/rules/`.

## Working style

Small, reviewable changes. No speculative abstraction, broad rewrites, or unrelated cleanup. Never implement a later phase because an earlier one finished in the same session. At each phase boundary: run required tests, update `STATE.md` and `HANDOFF.md`, record decisions in `docs/DECISIONS.md`, show what changed versus the plan, and stop for review. Separate verified facts, inferences, recommendations, and decisions needed from the owner.
