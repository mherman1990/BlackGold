import { createHash, randomUUID } from "node:crypto";

export type Sha256Hex = string & { readonly __brand: "Sha256Hex" };

export function sha256Hex(input: string | Uint8Array): Sha256Hex {
  return createHash("sha256").update(input).digest("hex") as Sha256Hex;
}

/** Deterministic JSON: sorted object keys, no whitespace, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function hashJson(value: unknown): Sha256Hex {
  return sha256Hex(canonicalJson(value));
}

/** Deterministic identifier derived from a namespace and stable parts. Same inputs always yield the same id. */
export function deterministicId(namespace: string, ...parts: readonly (string | number)[]): string {
  return `${namespace}_${sha256Hex(`${namespace} ${parts.map(String).join(" ")}`).slice(0, 32)}`;
}

/** Random identifier for records that are not derived from other data. */
export function randomId(namespace: string): string {
  return `${namespace}_${randomUUID().replaceAll("-", "")}`;
}
