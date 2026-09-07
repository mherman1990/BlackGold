import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dec, utc, type Db } from "@blackgold/shared";
import { openCoreDb } from "../src/db/open.ts";
import { modelCallCount, modelCallSpend, recordModelCall, type ModelCallLogRow } from "../src/research/model-call-log.ts";

function db(): Db {
  const dir = mkdtempSync(join(tmpdir(), "bg-mcl-"));
  return openCoreDb({ dbPath: join(dir, "m.sqlite") }).db;
}

function row(overrides: Partial<ModelCallLogRow> = {}): ModelCallLogRow {
  return {
    at: utc("2026-01-10T21:05:00.000Z"),
    strategyVersion: "etf-trend-vol@1",
    candidateId: "XLK",
    modelId: "claude-haiku-4-5",
    servedModelId: "claude-haiku-4-5",
    promptVersion: "p1",
    promptHash: `sha256:${"1".repeat(64)}`,
    schemaHash: `sha256:${"2".repeat(64)}`,
    packetHash: `sha256:${"3".repeat(64)}`,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: 800,
    costUsd: "0.05",
    latencyMs: 1200,
    attempts: 1,
    outcome: "assessed",
    validation: "valid",
    ...overrides,
  };
}

describe("model call log", () => {
  it("records a call and counts it", () => {
    const d = db();
    recordModelCall(d, row());
    expect(modelCallCount(d)).toBe(1);
  });

  it("sums decimal spend for the UTC day and month, and no other period leaks in", () => {
    const d = db();
    recordModelCall(d, row({ at: utc("2026-01-10T21:05:00.000Z"), costUsd: "0.05" }));
    recordModelCall(d, row({ at: utc("2026-01-10T22:00:00.000Z"), costUsd: "0.10" }));
    recordModelCall(d, row({ at: utc("2026-01-11T14:00:00.000Z"), costUsd: "0.20" })); // next day, same month
    recordModelCall(d, row({ at: utc("2026-02-01T14:00:00.000Z"), costUsd: "1.00" })); // next month
    const spend = modelCallSpend(d, utc("2026-01-10T23:59:00.000Z"));
    expect(spend.spentTodayUsd.equals(new Dec("0.15"))).toBe(true); // the two Jan-10 calls
    expect(spend.spentMonthUsd.equals(new Dec("0.35"))).toBe(true); // all three January calls
  });

  it("counts an abstention with zero cost", () => {
    const d = db();
    recordModelCall(d, row({ outcome: "abstained", abstainCode: "BUDGET_EXCEEDED", validation: "not_reached", costUsd: "0", attempts: 0 }));
    const spend = modelCallSpend(d, utc("2026-01-10T23:59:00.000Z"));
    expect(spend.spentTodayUsd.equals(new Dec("0"))).toBe(true);
    expect(modelCallCount(d)).toBe(1);
  });

  it("is append-only: update and delete are refused", () => {
    const d = db();
    recordModelCall(d, row());
    expect(() => d.prepare("UPDATE model_calls SET cost_usd = '9.99' WHERE id = 1").run()).toThrow();
    expect(() => d.prepare("DELETE FROM model_calls WHERE id = 1").run()).toThrow();
  });
});
