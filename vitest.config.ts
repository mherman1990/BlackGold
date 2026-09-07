import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string): string => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

/** Suite timeout, applied to the root and to every project (projects do not inherit the root value). */
const TIMEOUT_MS = 30_000;

export default defineConfig({
  resolve: {
    alias: {
      "@blackgold/shared": src("shared"),
      "@blackgold/core": src("core"),
      "@blackgold/broker-gateway": src("broker-gateway"),
    },
  },
  test: {
    /**
     * Thirty seconds, deliberately not vitest's 5-second default.
     *
     * Several suites drive a full point-in-time backtest or seed a fixture market through the observation
     * store. Those legitimately take two to four seconds each, and the feature engine re-reads its window at
     * every decision instant on purpose - that is the honest cost of reading point-in-time and is not cached
     * in production. Against a 5-second ceiling those tests passed on a fast machine and timed out on a
     * slower CI runner, so the same commit went green or red depending on which runner picked it up.
     *
     * Thirty seconds is roughly an order of magnitude above the slowest legitimate test, so runner speed
     * cannot decide an outcome, while a genuine hang still fails instead of running forever. If a test
     * approaches this budget, the test is too slow - do not raise the number.
     *
     * IMPORTANT: it must be set on EVERY project below, not only here. A vitest project does not inherit the
     * root `test.testTimeout`; a project with its own `test` block falls back to the 5-second default. Setting
     * it only at the root silently left `temporal` (and `unit`, and `policy`) at 5 seconds, which is exactly
     * the flake this value was meant to remove - `temporal/strategy-decisions.test.ts` timed out at 5000ms on
     * a loaded CI runner. `TIMEOUT_MS` is applied to each project so no suite can be forgotten.
     */
    testTimeout: TIMEOUT_MS,
    projects: [
      { test: { name: "unit", include: ["packages/*/test/**/*.test.ts"], environment: "node", testTimeout: TIMEOUT_MS } },
      { test: { name: "policy", include: ["test/policy/**/*.test.ts"], environment: "node", testTimeout: TIMEOUT_MS } },
      { test: { name: "temporal", include: ["test/temporal/**/*.test.ts"], environment: "node", testTimeout: TIMEOUT_MS } },
    ],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
