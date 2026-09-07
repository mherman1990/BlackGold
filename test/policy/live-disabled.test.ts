import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("../..", import.meta.url).pathname;

function trackedSource(): string[] {
  return execFileSync("git", ["ls-files", "packages", "config", "blackgold-trading", "Dockerfile"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f && !f.endsWith(".md"));
}

describe("live trading is absent by construction (Phase 0)", () => {
  it("no real broker SDK or trading host anywhere, and the model-provider host only in the model egress module", () => {
    // data.alpaca.markets (market data, read-only) is an allowlisted public source; the TRADING hosts are not.
    // No provider SDK is used anywhere - a thin fetch keeps the dependency surface minimal - so the SDK stays
    // forbidden. The model-provider HOST is allowed in exactly one module: the model egress path (F2), which
    // is the counterpart to data/http.ts for the one thing it cannot do, a POST to the inference API.
    const MODEL_EGRESS = "packages/core/src/model/provider-http.ts";
    const forbiddenEverywhere = [
      /@alpacahq\//,
      /(?:^|[^.\w])api\.alpaca\.markets|paper-api\.alpaca\.markets|broker-api\.alpaca\.markets/,
      /schwabapi|api\.schwab(?:api)?\.com|developer\.schwab\.com/,
      /robinhood/i,
      /@anthropic-ai\/sdk/,
      /openai/i,
    ];
    const hits: string[] = [];
    for (const f of trackedSource()) {
      const text = readFileSync(`${ROOT}/${f}`, "utf8");
      for (const re of forbiddenEverywhere) if (re.test(text)) hits.push(`${f}: ${re.source}`);
      if (text.includes("api.anthropic.com") && f !== MODEL_EGRESS) hits.push(`${f}: api.anthropic.com outside the model egress module`);
    }
    expect(hits).toEqual([]);
  });

  it("outbound HTTP exists only in the two allowlisted egress modules (data reads, model POST)", () => {
    const DATA_EGRESS = "packages/core/src/data/http.ts";
    const MODEL_EGRESS = "packages/core/src/model/provider-http.ts";
    const egressModules = new Set([DATA_EGRESS, MODEL_EGRESS]);
    const hits: string[] = [];
    for (const f of trackedSource().filter((p) => p.startsWith("packages/") && p.includes("/src/") && !egressModules.has(p))) {
      const text = readFileSync(`${ROOT}/${f}`, "utf8");
      if (/\bfetch\s*\(/.test(text) || /from\s+"node:https?"/.test(text) || /from\s+"undici"/.test(text)) {
        // The core `serve` command may run a LOCAL http server (node:http listen), which is allowed; outbound requests are not.
        if (!text.includes("createServer") || /\bfetch\s*\(/.test(text) || /\.request\s*\(/.test(text)) hits.push(f);
      }
    }
    expect(hits).toEqual([]);
    // The data-source egress is read-only: allowlisted and never a mutating method.
    const dataEgress = readFileSync(`${ROOT}/${DATA_EGRESS}`, "utf8");
    expect(dataEgress).toMatch(/allowlist/);
    expect(dataEgress).not.toMatch(/method:\s*"(POST|PUT|DELETE|PATCH)"/);
    // The model egress posts to exactly one host - the model provider - and to no broker or trading host.
    const modelEgress = readFileSync(`${ROOT}/${MODEL_EGRESS}`, "utf8");
    expect(modelEgress).toMatch(/api\.anthropic\.com/);
    expect(modelEgress).not.toMatch(/alpaca|schwab|robinhood/i);
  });

  it("no dependency on a broker or model provider package is declared", () => {
    for (const p of ["shared", "core", "broker-gateway"]) {
      const pkg = JSON.parse(readFileSync(`${ROOT}/packages/${p}/package.json`, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const names = Object.keys(pkg.dependencies ?? {});
      expect(names.filter((n) => /alpaca|schwab|robinhood|anthropic|openai/i.test(n))).toEqual([]);
    }
  });

  it("compose does not expose the gateway and does not publish host ports", () => {
    const compose = readFileSync(`${ROOT}/blackgold-trading/docker-compose.yml`, "utf8");
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).toMatch(/APP_HOST: blackgold-trading_core_1/);
    expect(compose).not.toMatch(/APP_HOST: blackgold-trading_gateway_1/);
  });

  it("no environment variable in the compose file selects a live mode", () => {
    const compose = readFileSync(`${ROOT}/blackgold-trading/docker-compose.yml`, "utf8");
    expect(compose).not.toMatch(/LIVE_MANUAL|LIVE_LIMITED/);
  });
});
