import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { CONFIG_SCHEMAS } from "./schema.ts";

/**
 * Emit JSON Schema (draft 2020-12) for every config file from the zod definitions.
 * Usage (after `npx tsc -b packages/core`): node packages/core/dist/config/emit-json-schema.js [outDir]
 * Default outDir is <repo>/config/schema. The emitted files are committed so editors can validate YAML.
 */
export function emitJsonSchemas(outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [name, schema] of Object.entries(CONFIG_SCHEMAS)) {
    // `io: "input"` describes what a config FILE may contain: defaults optional, pre-transform shapes.
    const json = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" });
    const out = { $id: `https://blackgold.local/config/schema/${name}.schema.json`, title: `blackgold ${name}`, ...json };
    const path = join(outDir, `${name}.schema.json`);
    writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
    written.push(path);
  }
  return written;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/config -> packages/core -> packages -> repo root
  const defaultOut = resolve(here, "..", "..", "..", "..", "config", "schema");
  const outDir = process.argv[2] ?? defaultOut;
  for (const p of emitJsonSchemas(outDir)) console.log(p);
}
