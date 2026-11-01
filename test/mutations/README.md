# Mutation records

One YAML file per source file. Each record lists mutations that `scripts/check-mutations.ts` applies to the
file in place, one at a time, running the named test and requiring it to go red, then restoring the original
bytes. A mutation that survives is a failure: the test named does not guard the invariant it claims to.

```yaml
file: packages/core/src/risk/orders.ts
mutations:
  - name: notional cap must be strict (at the cap passes, over fails)
    find: "if (notional.gt(notionalCap))"      # must occur exactly once in the file
    replace: "if (notional.gte(notionalCap))"
    test: packages/core/test/risk-orders.test.ts
    testName: "notional: at 1500 USD passes"   # optional vitest -t filter; omit to run the whole file
```

Records are **mandatory** for any changed file in the set `MANDATORY_PATTERNS` in `scripts/check-mutations.ts`:

- `packages/core/src/{risk,decision,execution,live,ledger,compliance}/**`
- `packages/core/src/research/{nav,stats,aggregate,simulator}.ts`
- `packages/core/src/strategy/construct.ts`
- `packages/core/src/data/adapters/corporate-actions*.ts`, `packages/core/src/data/{lag-rules,quality}.ts`,
  `packages/core/src/data/pit/**`
- `packages/core/src/{market,calendar,universe}/**`
- `packages/core/src/config/load.ts`
- `packages/core/src/research/experiment-cli.ts` (the owner's registration guards)
- `packages/broker-gateway/src/**`

CI runs the check over the files changed against `origin/main`; run `npm run check:mutations -- --all` to
verify every record. A guard is removed only together with the file it guards: deleting or retargeting a
record whose source still exists fails the check, in both modes. Deleting a source and its record together is
fine.

Write the mutation that mirrors the defect a wrong implementation would have: an off-by-one at a cap, an
inverted comparison, a dropped branch, a swapped source. The fixture anti-patterns in `HANDOFF.md` section 3
(uniform fixtures, an expected value reachable by two behaviours, a redundant second guard) are what a
surviving mutation usually reveals.
