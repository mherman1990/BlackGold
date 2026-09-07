import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dec, utc, type Db } from "@blackgold/shared";
import { openCoreDb } from "../src/db/open.ts";
import { modelCallCount } from "../src/research/model-call-log.ts";
import { DeterministicStubAdapter } from "../src/model/adapter.ts";
import { CircuitBreaker, type Pricing } from "../src/model/assess.ts";
import { runAnalyst, type AnalystInput } from "../src/analyst/run-analyst.ts";
import type { AsOfQuery, AsOfResult, ReadOnlyPointInTime, StoredObservation } from "../src/data/pit/types.ts";

function db(): Db {
  const dir = mkdtempSync(join(tmpdir(), "bg-analyst-"));
  return openCoreDb({ dbPath: join(dir, "a.sqlite") }).db;
}

function obs(id: number, value: unknown): StoredObservation {
  return {
    id,
    sourceId: "sec.submissions",
    sourceLocator: `edgar/${id}`,
    availableAt: utc("2026-01-05T21:00:00.000Z"),
    ingestedAt: utc("2026-01-05T21:00:00.000Z"),
    rawContentHash: `sha256:${"a".repeat(64)}`,
    adapterVersion: "1",
    parserVersion: "1",
    value,
    qualityFlags: [],
  };
}

function pitWith(rows: readonly StoredObservation[]): ReadOnlyPointInTime {
  return {
    asOf<T = unknown>(q: AsOfQuery): AsOfResult<T> {
      const visible = rows.filter((r) => r.sourceId === q.sourceId && Date.parse(r.availableAt) <= Date.parse(q.decisionAt));
      return { rows: visible as StoredObservation<T>[], labels: [], processingDelayMs: 0 };
    },
  };
}

const PRICING: Pricing = { inputPerMTokUsd: new Dec("1"), outputPerMTokUsd: new Dec("5"), cachedInputPerMTokUsd: new Dec("0.10") };

function validRaw(): unknown {
  return {
    assessmentId: "a1",
    candidateId: "XLK",
    strategyVersion: "etf-trend-vol@1",
    evidenceFor: [{ sourceId: "obs-1", fact: "up" }],
    evidenceAgainst: [],
    missingEvidence: [],
    ontologyTags: [],
    factorsTouched: ["momentum"],
    thesis: "trend intact",
    strongestDissent: "rates",
    falsifiers: [],
    expectedHorizon: "20 sessions",
    uncertainty: "medium",
    abstain: false,
  };
}

function input(d: Db, over: Partial<AnalystInput> = {}): AnalystInput {
  return {
    db: d,
    pit: pitWith([obs(1, "revenue up")]),
    adapter: new DeterministicStubAdapter("claude-x", { raw: validRaw(), usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0 } }),
    breaker: new CircuitBreaker(2),
    pricing: PRICING,
    budgets: { perCallUsd: new Dec("0.50"), perDayUsd: new Dec("5.00"), perMonthUsd: new Dec("60.00") },
    now: utc("2026-01-10T21:05:00.000Z"),
    strategyId: "etf-trend-vol",
    strategyVersion: "etf-trend-vol@1",
    candidateId: "XLK",
    decisionAt: utc("2026-01-10T00:00:00.000Z"),
    sources: [{ sourceId: "sec.submissions" }],
    excerpt: (o: StoredObservation) => String(o.value),
    deterministicFactors: new Set(["momentum"]),
    prompt: { version: "p1", text: "You are the Analyst." },
    deadlineMs: 1_000,
    maxAttempts: 1,
    runMode: "PROSPECTIVE",
    ...over,
  };
}

describe("runAnalyst end to end", () => {
  it("builds a packet, assesses, and archives the call", async () => {
    const d = db();
    const out = await runAnalyst(input(d));
    expect(out.outcome).toBe("assessed");
    expect(out.factsInPacket).toBe(1);
    expect(out.assessment?.candidateId).toBe("XLK");
    expect(modelCallCount(d)).toBe(1);
  });

  it("derives the running budget from the persisted log: a prior big call forces an abstention", async () => {
    const d = db();
    // First call: cost is 1000 input tokens at $1/MTok = $0.001. To exhaust the daily budget, run many? Instead,
    // stub a large-usage call so its cost pushes spend over the daily cap, then the next call abstains.
    await runAnalyst(input(d, { adapter: new DeterministicStubAdapter("claude-x", { raw: validRaw(), usage: { inputTokens: 6_000_000, outputTokens: 0, cacheReadInputTokens: 0 } }) }));
    // Spend is now $6.00 > $5.00 daily cap; the next call must abstain before calling the provider.
    const out = await runAnalyst(input(d));
    expect(out).toMatchObject({ outcome: "abstained", abstainCode: "BUDGET_EXCEEDED" });
    expect(out.record.attempts).toBe(0);
    expect(modelCallCount(d)).toBe(2); // both calls archived, including the abstention
  });

  it("labels a historical replay contaminated in the persisted row", async () => {
    const d = db();
    await runAnalyst(input(d, { runMode: "HISTORICAL_REPLAY" }));
    const row = d.prepare("SELECT run_mode, contamination_label FROM model_calls WHERE id = 1").get() as { run_mode: string; contamination_label: string | null };
    expect(row.run_mode).toBe("HISTORICAL_REPLAY");
    expect(row.contamination_label).toBe("HISTORICAL_REPLAY_CONTAMINATED");
  });

  it("archives an abstention when the model serves the wrong id", async () => {
    const d = db();
    const out = await runAnalyst(input(d, { adapter: new DeterministicStubAdapter("claude-x", { raw: validRaw(), servedModelId: "claude-y" }) }));
    expect(out).toMatchObject({ outcome: "abstained", abstainCode: "MODEL_ID_MISMATCH" });
    expect(modelCallCount(d)).toBe(1);
  });
});
