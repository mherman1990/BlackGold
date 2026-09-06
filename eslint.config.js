// @ts-check
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/** Dependency boundaries. These are enforcement for the architecture in docs/PROPOSED_REPOSITORY_TREE.md. */
const boundaries = [
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["@blackgold/broker-gateway", "@blackgold/broker-gateway/*", "**/broker-gateway/**"], message: "core must never import the broker gateway (credential boundary)." },
      ] }],
    },
  },
  {
    files: ["packages/broker-gateway/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["@blackgold/core", "@blackgold/core/*", "**/packages/core/**"], message: "gateway must never import core." },
      ] }],
    },
  },
  {
    files: ["packages/core/src/analyst/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["**/orders/**", "**/portfolio/**", "**/risk/**", "**/broker/**"], message: "analyst (LLM layer) may not touch orders, portfolio, risk, or brokers." },
      ] }],
    },
  },
  {
    files: ["packages/**/*.ts"],
    ignores: ["packages/*/src/config/**"],
    rules: {
      "no-restricted-properties": ["error", { object: "process", property: "env", message: "Read environment only in config/." }],
    },
  },
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**"] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-restricted-syntax": ["error", {
        selector: "BinaryExpression[operator=/^[+\\-*\\/]$/] > Literal[raw=/^\\d+\\.\\d+$/]",
        message: "Float literal arithmetic is forbidden; use Decimal from @blackgold/shared for money.",
      }],
    },
  },
  ...boundaries,
  { files: ["eslint.config.js", "vitest.config.ts", "scripts/**/*.ts"], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
