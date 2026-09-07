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
  it("no real broker SDK, broker trading host, or model provider SDK is referenced in source", () => {
    // data.alpaca.markets (market data, read-only) is an allowlisted public source; the TRADING hosts are not.
    const forbidden = [
      /@alpacahq\//,
      /(?:^|[^.\w])api\.alpaca\.markets|paper-api\.alpaca\.markets|broker-api\.alpaca\.markets/,
      /schwabapi|api\.schwab(?:api)?\.com|developer\.schwab\.com/,
      /robinhood/i,
      /@anthropic-ai\/sdk/,
      /api\.anthropic\.com/,
      /openai/i,
    ];
    const hits: string[] = [];
    for (const f of trackedSource()) {
      const text = readFileSync(`${ROOT}/${f}`, "utf8");
      for (const re of forbidden) if (re.test(text)) hits.push(`${f}: ${re.source}`);
    }
    expect(hits).toEqual([]);
  });

  it("outbound HTTP exists only in the single allowlisted egress module", () => {
    const EGRESS = "packages/core/src/data/http.ts";
    const hits: string[] = [];
    for (const f of trackedSource().filter((p) => p.startsWith("packages/") && p.includes("/src/") && p !== EGRESS)) {
      const text = readFileSync(`${ROOT}/${f}`, "utf8");
      if (/\bfetch\s*\(/.test(text) || /from\s+"node:https?"/.test(text) || /from\s+"undici"/.test(text)) {
        // The core `serve` command may run a LOCAL http server (node:http listen), which is allowed; outbound requests are not.
        if (!text.includes("createServer") || /\bfetch\s*\(/.test(text) || /\.request\s*\(/.test(text)) hits.push(f);
      }
    }
    expect(hits).toEqual([]);
    const egress = readFileSync(`${ROOT}/${EGRESS}`, "utf8");
    expect(egress).toMatch(/allowlist/);
    expect(egress).not.toMatch(/method:\s*"(POST|PUT|DELETE|PATCH)"/);
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
