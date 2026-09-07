#!/usr/bin/env node
import { GATEWAY_VERSION, health } from "./health.ts";

/**
 * Broker gateway CLI. Phase 0 exposes only `health` and `version`. There is no serve command, no HTTP surface,
 * and no credential loading: this build cannot reach a broker.
 */
export function run(argv: readonly string[], out: (line: string) => void): number {
  const cmd = argv[0] ?? "";
  switch (cmd) {
    case "health":
      out(JSON.stringify(health()));
      return 0;
    case "version":
      out(GATEWAY_VERSION);
      return 0;
    default:
      out(`usage: blackgold-broker-gateway <health|version>${cmd === "" ? "" : ` (unknown command: ${cmd})`}`);
      return 2;
  }
}

process.exitCode = run(process.argv.slice(2), (line) => {
  console.log(line);
});
