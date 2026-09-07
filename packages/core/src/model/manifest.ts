import { Dec } from "@blackgold/shared";
import type { ModelEntry, ModelManifestConfig } from "../config/schema.ts";
import type { Pricing } from "./assess.ts";

/**
 * Resolve a pinned model id against the capability manifest, failing closed (MP-06; threat model T-08).
 *
 * Model ids never live in code (D-11); a strategy version pins one and it must resolve to a manifest entry.
 * An unknown id, or an entry whose dated pricing/capability check is older than `modelConfigMaxAgeDays`, is a
 * hard error: the caller must not proceed to a provider call on an unverified or stale configuration.
 */
export class ModelConfigError extends Error {
  constructor(reason: string) {
    super(`Model configuration rejected: ${reason}`);
    this.name = "ModelConfigError";
  }
}

const MS_PER_DAY = 86_400_000;

export function resolveModelEntry(
  manifest: ModelManifestConfig,
  modelId: string,
  opts: { now: Date; maxAgeDays: number },
): ModelEntry {
  const entry = manifest.models.find((m) => m.modelId === modelId);
  if (entry === undefined) {
    throw new ModelConfigError(`pinned model id "${modelId}" is not in the manifest`);
  }
  const checkedAtMs = Date.parse(`${entry.pricing.checkedAt}T00:00:00.000Z`);
  const ageDays = (opts.now.getTime() - checkedAtMs) / MS_PER_DAY;
  if (ageDays > opts.maxAgeDays) {
    throw new ModelConfigError(
      `capability/pricing for "${modelId}" was last verified ${Math.floor(ageDays)}d ago, over the ${opts.maxAgeDays}d limit; re-verify before use`,
    );
  }
  return entry;
}

/** Build the decimal pricing the orchestration charges against from a resolved manifest entry. */
export function pricingFrom(entry: ModelEntry): Pricing {
  return {
    inputPerMTokUsd: new Dec(entry.pricing.inputPerMTokUsd),
    outputPerMTokUsd: new Dec(entry.pricing.outputPerMTokUsd),
    cachedInputPerMTokUsd: new Dec(entry.pricing.cachedInputPerMTokUsd),
  };
}
