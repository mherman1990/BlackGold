#!/usr/bin/env node
import { GATEWAY_VERSION, health } from "./health.ts";

/**
 * Broker gateway CLI. Phase 0 exposes `health`, `version`, and `serve`. `serve` only keeps the container alive
 * and reports health on a fixed interval: there is no HTTP surface, no listener, and no credential loading.
 * This build cannot reach a broker.
 */
export function run(argv: readonly string[], out: (line: string) => void): number | "serve" {
  const cmd = argv[0] ?? "";
  switch (cmd) {
    case "health":
      out(JSON.stringify(health()));
      return 0;
    case "version":
      out(GATEWAY_VERSION);
      return 0;
    case "serve":
      return "serve";
    default:
      out(`usage: blackgold-broker-gateway <health|serve|version>${cmd === "" ? "" : ` (unknown command: ${cmd})`}`);
      return 2;
  }
}

const result = run(process.argv.slice(2), (line) => {
  console.log(line);
});
if (result === "serve") {
  console.log(JSON.stringify({ ...health(), version: GATEWAY_VERSION, serving: true, listener: "none" }));
  const interval = setInterval(() => {
    console.log(JSON.stringify({ ...health(), at: new Date().toISOString() }));
  }, 300_000);
  const stop = (): void => {
    clearInterval(interval);
    console.log("blackgold-broker-gateway stopped");
    process.exitCode = 0;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} else {
  process.exitCode = result;
}
