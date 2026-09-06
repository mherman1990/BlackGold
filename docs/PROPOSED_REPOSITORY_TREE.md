# Proposed repository tree

Proposal only. Nothing under `packages/`, `scripts/`, `.github/`, or `blackgold-trading/` exists yet. Phase 0 creates the skeleton; later phases fill it. Package boundaries exist to make the safety properties checkable: the gateway is a separate package with its own dependency graph, and core cannot import it.

```
BlackGold/
├── CLAUDE.md                          # stable Claude Code instructions (< 200 lines)
├── CLAUDE.local.md                    # gitignored operator context (never committed)
├── README.md
├── LICENSE                            # after D-21
├── PLAN.md  STATE.md  HANDOFF.md  CHANGELOG.md
├── package.json                       # npm workspaces; single version authority
├── package-lock.json
├── tsconfig.base.json
├── umbrel-app-store.yml               # id: blackgold
├── blackgold-trading/                 # the one Umbrel app
│   ├── umbrel-app.yml
│   ├── docker-compose.yml
│   ├── icon.svg
│   └── exports.sh                     # only if UM-08 verifies it is needed
├── Dockerfile                         # multi-stage, multi-arch, one image, role by command
├── .dockerignore
├── .github/
│   ├── pull_request_template.md
│   ├── CODEOWNERS
│   └── workflows/
│       ├── ci.yml                     # PR: lint, typecheck, test, policy, identity, secrets, multi-arch build (no push)
│       ├── release.yml                # v* tag only: build, push, SBOM, scan
│       └── release-verify.yml         # manual: inspect manifest, disposable install
├── .claude/
│   └── rules/
│       ├── broker-gateway.md
│       ├── temporal-data.md
│       └── umbrel-identity.md
├── docs/                              # specifications, decisions, registers (this Discovery Pack)
│   ├── DISCOVERY_PACK.md  PRODUCT_SPEC.md  DECISIONS.md  ASSUMPTIONS_AND_GAPS.md
│   ├── IDENTITY.md  REPOSITORY_AND_PR_WORKFLOW.md  UMBREL_STORE_AND_RELEASE.md
│   ├── CONTEXT_PROVENANCE.md  THREAT_MODEL.md  CAPABILITY_REGISTER.md
│   ├── DATA_PROVENANCE_SPEC.md  EXPERIMENT_PROTOCOL.md  AUTOMATION_AND_LIVE_GATES.md
│   ├── RESOURCE_BUDGET.md  PROPOSED_REPOSITORY_TREE.md  CORE_INTERFACES.md
│   ├── capabilities/                  # per-vendor registers
│   ├── adr/                           # future ADRs if DECISIONS.md outgrows one file
│   └── runbooks/                      # Phase 5+: install, recovery, UNKNOWN order, halt, restore
├── strategies/                        # one directory per strategy id
│   ├── README.md
│   ├── etf-trend-vol/
│   │   ├── ALPHA_CHARTER.md
│   │   ├── charter.yaml               # machine-readable companion, frozen at registration
│   │   └── experiments/               # registration records (results live in SQLite, not git)
│   ├── form4-insider-cluster/
│   └── filing-change-challenger/
├── config/
│   ├── schema/                        # zod/JSON schemas: app config, risk.yaml, financial picture, restricted list, LIVE_AUTHORIZATION
│   ├── examples/                      # fake-value examples committed
│   └── local/                         # gitignored real config
├── packages/
│   ├── shared/                        # @blackgold/shared: types, decimal money, time/calendar, ids, hashing, event log codec
│   │   └── src/{types,money,time,ids,hash,events}/
│   ├── core/                          # @blackgold/core: no trading credential, cannot import broker-gateway
│   │   └── src/
│   │       ├── main.ts  health.ts
│   │       ├── config/                # schema loading, mode, pinned model ids
│   │       ├── db/                    # SQLite (WAL), migrations, online backup, integrity
│   │       ├── ledger/                # append-only hash-chained event log, daily seal
│   │       ├── scheduler/             # exchange-calendar jobs, idempotency keys, missed-run detection
│   │       ├── data/                  # adapters: sec-edgar, fred, cftc, treasury, market-data; artifact store; PIT repository
│   │       ├── universe/              # date-effective membership snapshots
│   │       ├── research/              # experiment registry, backtester, fill/cost simulator, benchmarks, metrics
│   │       ├── strategies/            # deterministic candidate engines per charter
│   │       ├── analyst/               # evidence packet builder, ModelAdapter, ResearchAssessment validation, budgets
│   │       ├── household/             # financial picture, exposure flags, restricted list, cooling periods
│   │       ├── portfolio/             # deterministic construction and sizing
│   │       ├── compliance/            # pure rules with reason codes
│   │       ├── risk/                  # pure rules, stateful limits, halt states
│   │       ├── orders/                # OrderIntent formation, state machine (core side), approval service
│   │       ├── reconcile/             # steward: broker truth vs ledger
│   │       ├── performance/           # NAV, total return, costs, tax lots, attribution, arms B0–D1
│   │       ├── reports/               # CLI reports; later read-only HTTP status page on 8479
│   │       └── notify/                # notification adapter (stub first)
│   └── broker-gateway/                # @blackgold/broker-gateway: holds the credential, minimal surface
│       └── src/
│           ├── main.ts  health.ts
│           ├── auth/                  # authorization artifact verification, intent signature check
│           ├── guards/                # second copy of hard caps and sleeve allowlist
│           ├── adapters/
│           │   ├── synthetic/         # Phase 0: deterministic fake broker with fault injection
│           │   ├── alpaca-paper/      # Phase 5
│           │   └── schwab/            # Phase 6, after capability verification
│           └── state-machine/         # persisted order lifecycle, UNKNOWN handling
├── scripts/
│   ├── check-identity.ts              # cross-file identifier and version consistency
│   ├── check-no-mutation-methods.ts   # policy test: read-only interfaces expose no mutation
│   ├── backup.sh  restore.sh  integrity-check.sh
│   └── pi-benchmark.sh                # RAM/CPU/temp/sqlite timing on the Pi
└── test/
    ├── fixtures/                      # sanitized recordings, temporal fixtures, adversarial documents
    ├── policy/                        # CI gates: account isolation, live disabled, no secrets, identity
    ├── temporal/                      # availableAt enforcement, vintages, DST, early close
    ├── orders/                        # state machine fault suite
    └── e2e/                           # container smoke tests
```

## Dependency rules (enforced by lint in Phase 0)

- `core` may import `shared`. `core` may not import `broker-gateway`.
- `broker-gateway` may import `shared`. It may not import `core`.
- `analyst/` may not import `orders/`, `portfolio/`, `risk/`, or any broker adapter.
- Provider SDKs (Anthropic, Alpaca, Schwab) appear only inside their adapter directory.
- Nothing under `packages/` reads environment variables directly except `config/`.

## What is committed versus not

Committed: code, schemas, migrations, fake-value config examples, prompts (versioned), Alpha Charters, experiment registrations, redacted fixtures, docs, runbooks. Not committed: SQLite, raw artifacts, ledgers, logs, backups, real config, `LIVE_AUTHORIZATION.yaml`, `CLAUDE.local.md`.
