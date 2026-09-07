# Configuration files and schemas

Black Gold core reads its configuration from `BLACKGOLD_*` environment variables (app config) and from
YAML files validated against zod schemas in `packages/core/src/config/schema.ts`. The `*.schema.json` files
in this directory are generated from those zod definitions and committed so editors and CI can validate the
YAML; regenerate them after any schema change:

```
npx tsc -b packages/core && node packages/core/dist/config/emit-json-schema.js
```

Fake-value examples live in `config/examples/`. Real files with household or account data belong under
`config/local/` (gitignored) or `${APP_DATA_DIR}` on the Pi, never in git.

| File | Schema | Purpose |
|---|---|---|
| `app.env.example` | `app.schema.json` | Process configuration: mode, data directories, display time zone, exchange, scheduler poll interval, notification adapter, LLM budgets, and the single `blackgold_sleeve` account reference. Loaded from `BLACKGOLD_*` variables by `loadAppConfig`. Live modes (`LIVE_MANUAL`, `LIVE_LIMITED`) are refused at load time: this build has no live path, and no single variable may enable one. Any sleeve role other than `blackgold_sleeve` is rejected. |
| `risk.yaml` | `risk.schema.json` | Every hard limit from `docs/PRODUCT_SPEC.md` section 8 with the D-15 defaults: sleeve cap, allowed instruments/directions/sessions/order types, position and concentration limits, exposure and cash floors, volatility scaling, liquidity thresholds, order caps, event blackouts, PDT prevention, price sanity rules, halt thresholds (`HALT_NEW_RISK` at 2% daily loss or 8% drawdown, `HOLD_ONLY` at 10%), staleness limits, and thesis expiry. Percentages and money are decimal strings. `leverage`, `extendedHours`, `fractionalShares`, and `automaticFlatten` are literal `false`; `manualRearmRequired` is literal `true`. |
| `financial-picture.yaml` | `financial-picture.schema.json` | Household picture used for the sleeve cap and exposure look-through (D-20): liquid investable assets, per-account values with coarse asset-class/sector/style exposures, and career-sensitivity flags. Dollar totals stay in local config and never reach a model or a notification. Stale beyond `staleAfterDays` blocks new risk. |
| `restricted-list.yaml` | `restricted-list.schema.json` | Names, themes, and ETFs that may not be traded; dated blackout windows; and pending removals that become effective only after `coolingPeriodDays` (D-14). Additions are immediate. |
| `LIVE_AUTHORIZATION.example.yaml` | `live-authorization.schema.json` | Shape of the owner-signed, expiring live authorization artifact (`docs/AUTOMATION_AND_LIVE_GATES.md` section 5). Phase 0 ships the schema only; there is no verifier, no signature key, and no live code path. A real artifact is gitignored. |

## Conventions

- Money, percentages, and ratios are strings such as `"0.05"`; parse with `dec()` from `@blackgold/shared`.
- Instants are ISO-8601 UTC strings ending in `Z`; calendar dates are `YYYY-MM-DD`. Quote them in YAML so
  they stay strings.
- Unknown or stale configuration fails closed for new risk. Missing optional fields take the schema default.
