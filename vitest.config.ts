import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const shared = fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@blackgold/shared": shared } },
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/test/**/*.test.ts"], environment: "node" } },
      { test: { name: "policy", include: ["test/policy/**/*.test.ts"], environment: "node" } },
      { test: { name: "temporal", include: ["test/temporal/**/*.test.ts"], environment: "node" } },
    ],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
