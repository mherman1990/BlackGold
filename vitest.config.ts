import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string): string => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

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
     * Thirty seconds, suite-wide, deliberately not vitest's 5-second default.
     *
     * Several suites drive a full point-in-time backtest or seed a fixture market through the observation
     * store. Those legitimately take two to four seconds each, and the feature engine re-reads its window at
     * every decision instant on purpose - that is the honest cost of reading point-in-time and is not cached
     * in production. Against a 5-second ceiling those tests passed on a fast machine and timed out on a
     * slower CI runner, so the same commit went green or red depending on which runner picked it up.
     *
     * This is set here rather than per file because the per-file approach was tried first and failed: the
     * two files that had already failed were fixed and `strategy-features.test.ts`, which has the same shape,
     * was missed and failed on the next run. One ceiling in one place cannot be forgotten for a new suite.
     *
     * Thirty seconds is roughly an order of magnitude above the slowest legitimate test, so runner speed
     * cannot decide an outcome, while a genuine hang still fails instead of running forever. If a test
     * approaches this budget, the test is too slow - do not raise the number.
     */
    testTimeout: 30_000,
    projects: [
      { test: { name: "unit", include: ["packages/*/test/**/*.test.ts"], environment: "node" } },
      { test: { name: "policy", include: ["test/policy/**/*.test.ts"], environment: "node" } },
      { test: { name: "temporal", include: ["test/temporal/**/*.test.ts"], environment: "node" } },
    ],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
