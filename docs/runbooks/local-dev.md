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

`BLACKGOLD_MODE` accepts `RESEARCH`, `BACKTEST`, `SHADOW`, `PAPER`. Any live mode makes every command exit non-zero: there is no live code path in this build.

The container image cannot be built in an environment without a Docker daemon; CI builds it for both architectures on every PR.
