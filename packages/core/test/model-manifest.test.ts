import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Dec } from "@blackgold/shared";
import { ModelManifestConfigSchema, parseYamlConfig } from "../src/index.ts";
import { ModelConfigError, pricingFrom, resolveModelEntry } from "../src/model/manifest.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

function manifest() {
  return parseYamlConfig(readFileSync(`${ROOT}config/examples/model-manifest.yaml`, "utf8"), ModelManifestConfigSchema, "model-manifest.yaml");
}

const CHECKED = new Date("2026-09-07T00:00:00.000Z");

describe("model capability manifest and resolver", () => {
  it("the example manifest parses and pins exact snapshot ids", () => {
    const m = manifest();
    expect(m.models.map((e) => e.modelId)).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
  });

  it("rejects a manifest with duplicate model ids", () => {
    const dup = { models: [entry("claude-x"), entry("claude-x")] };
    expect(ModelManifestConfigSchema.safeParse(dup).success).toBe(false);
  });

  it("resolves a pinned id to its entry when the config is fresh", () => {
    const entry = resolveModelEntry(manifest(), "claude-sonnet-5", { now: CHECKED, maxAgeDays: 90 });
    expect(entry.tier).toBe("synthesis");
    expect(entry.registeredTasks).toContain("synthesis");
  });

  it("fails closed on an unknown pinned id", () => {
    expect(() => resolveModelEntry(manifest(), "claude-ghost", { now: CHECKED, maxAgeDays: 90 })).toThrow(ModelConfigError);
  });

  it("fails closed when the capability/pricing check is stale", () => {
    const later = new Date("2027-01-01T00:00:00.000Z"); // ~116 days after checkedAt
    expect(() => resolveModelEntry(manifest(), "claude-haiku-4-5", { now: later, maxAgeDays: 90 })).toThrow(ModelConfigError);
  });

  it("builds decimal pricing from a resolved entry", () => {
    const entry = resolveModelEntry(manifest(), "claude-haiku-4-5", { now: CHECKED, maxAgeDays: 90 });
    const pricing = pricingFrom(entry);
    expect(pricing.inputPerMTokUsd.equals(new Dec("1.00"))).toBe(true);
    expect(pricing.outputPerMTokUsd.equals(new Dec("5.00"))).toBe(true);
  });
});

function entry(modelId: string) {
  return {
    provider: "anthropic",
    modelId,
    tier: "fast",
    structuredOutput: true,
    promptCaching: true,
    batch: { supported: true, completionWindowHours: 24 },
    contextTokens: 200000,
    pricing: { inputPerMTokUsd: "1.00", outputPerMTokUsd: "5.00", cachedInputPerMTokUsd: "0.10", checkedAt: "2026-09-07" },
    registeredTasks: ["extraction"],
  };
}
