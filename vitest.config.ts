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
    projects: [
      { test: { name: "unit", include: ["packages/*/test/**/*.test.ts"], environment: "node" } },
      { test: { name: "policy", include: ["test/policy/**/*.test.ts"], environment: "node" } },
      { test: { name: "temporal", include: ["test/temporal/**/*.test.ts"], environment: "node" } },
    ],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
