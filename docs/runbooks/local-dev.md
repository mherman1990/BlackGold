# Local development

Requires Node.js 24 (Node 22.18 or later works for development; `node:sqlite` prints an experimental warning on 22).

```bash
npm ci                      # .npmrc sets legacy-peer-deps to work around an npm 10 arborist crash on vitest peers
npm run build               # tsc -b: shared, core, broker-gateway
npm run check               # lint, typecheck, all tests, identity check, secret scan
npm run test                # unit + policy + temporal projects
npm run test:policy         # CI safety gates only
```

Run the CLIs against a scratch data directory:

```bash
export BLACKGOLD_DATA_DIR=./data
node packages/core/dist/main.js migrate
node packages/core/dist/main.js health
node packages/core/dist/main.js run-jobs
node packages/core/dist/main.js seal
node packages/core/dist/main.js verify-chain
node packages/core/dist/main.js backup
node packages/broker-gateway/dist/main.js health
```

Phase 1 research-kernel commands (network access only through the allowlisted egress client; every ingest needs
`BLACKGOLD_SEC_USER_AGENT_CONTACT`, and FRED/Alpaca need their keys in the environment):

```bash
node packages/core/dist/main.js ingest sec-submissions --cik 320193
node packages/core/dist/main.js ingest fred --series CPIAUCSL --realtime-start 2020-01-01 --realtime-end 2026-09-01
node packages/core/dist/main.js ingest cot --dataset legacy_futures --from 2026-01-01 --to 2026-09-01
node packages/core/dist/main.js ingest alpaca-bars --symbols VTI,SPY --start 2026-01-01 --end 2026-09-01
node packages/core/dist/main.js pit count --source alpaca.iex.bars.1d
node packages/core/dist/main.js pit latest --source fred.CPIAUCSL
node packages/core/dist/main.js snapshot create --dataset prices_daily --description "first ETF pull"
node packages/core/dist/main.js artifacts verify --sample 100
```

Ingest refuses to run once the artifact store exceeds `BLACKGOLD_ARTIFACT_BUDGET_BYTES` (default 40 GiB) and records the refusal in the ledger. Rerunning an ingest deduplicates artifacts and observations.

`BLACKGOLD_MODE` accepts `RESEARCH`, `BACKTEST`, `SHADOW`, `PAPER`. Any live mode makes every command exit non-zero: there is no live code path in this build.

The container image cannot be built in an environment without a Docker daemon; CI builds it for both architectures on every PR.
