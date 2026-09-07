import { describe, expect, it } from "vitest";
import { Dec, utc } from "@blackgold/shared";
import { UNTRUSTED_SOURCE_NOTICE, type EvidencePacket } from "../src/research/packet.ts";
import { DeterministicStubAdapter } from "../src/model/adapter.ts";
import { CircuitBreaker, runAssessment, type BudgetState, type Pricing } from "../src/model/assess.ts";

const FACTORS = new Set(["momentum", "trend"]);

function packet(): EvidencePacket {
  return {
    packetVersion: 1,
    candidateId: "XLK",
    strategyId: "etf-trend-vol",
    strategyVersion: "etf-trend-vol@1",
    decisionAt: utc("2026-01-10T00:00:00.000Z"),
    untrustedSourceNotice: UNTRUSTED_SOURCE_NOTICE,
    facts: [
      {
        citationId: "obs-1",
        observationRowId: 1,
        sourceId: "sec.submissions",
        sourceLocator: "edgar/1",
        availableAt: utc("2026-01-05T21:00:00.000Z"),
        rawContentHash: `sha256:${"a".repeat(64)}`,
        excerpt: "revenue up",
      },
    ],
    exposureFlags: [],
    restrictions: [],
  };
}

function validRaw(overrides: Record<string, unknown> = {}): unknown {
  return {
    assessmentId: "asmt_1",
    candidateId: "XLK",
    strategyVersion: "etf-trend-vol@1",
    evidenceFor: [{ sourceId: "obs-1", fact: "revenue up" }],
    evidenceAgainst: [],
    missingEvidence: [],
    ontologyTags: ["momentum"],
    factorsTouched: ["momentum", "trend"],
    thesis: "trend intact",
    strongestDissent: "rates could compress the multiple",
    falsifiers: [],
    expectedHorizon: "20 sessions",
    uncertainty: "medium",
    abstain: false,
    ...overrides,
  };
}

const PRICING: Pricing = {
  inputPerMTokUsd: new Dec("1"),
  outputPerMTokUsd: new Dec("5"),
  cachedInputPerMTokUsd: new Dec("0.10"),
};

function budget(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    perCallUsd: new Dec("0.50"),
    perDayUsd: new Dec("5.00"),
    perMonthUsd: new Dec("60.00"),
    spentTodayUsd: new Dec("0"),
    spentMonthUsd: new Dec("0"),
    ...overrides,
  };
}

function opts(adapter: DeterministicStubAdapter, over: Partial<Parameters<typeof runAssessment>[0]> = {}) {
  return {
    adapter,
    packet: packet(),
    prompt: { version: "p1", text: "system prompt v1" },
    deterministicFactors: FACTORS,
    deadlineMs: 1_000,
    maxAttempts: 1,
    breaker: new CircuitBreaker(2),
    budget: budget(),
    pricing: PRICING,
    ...over,
  };
}

describe("runAssessment orchestration", () => {
  it("returns a validated assessment on a clean response and records telemetry", async () => {
    const adapter = new DeterministicStubAdapter("claude-x", { raw: validRaw(), usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0 }, latencyMs: 42 });
    const result = await runAssessment(opts(adapter));
    expect(result.outcome).toBe("assessed");
    if (result.outcome === "assessed") {
      expect(result.assessment.candidateId).toBe("XLK");
      expect(result.record.validation).toBe("valid");
      expect(result.record.costUsd).toBe("1"); // 1,000,000 input tokens at $1 / MTok
      expect(result.record.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.record.schemaHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.record.packetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.record.latencyMs).toBe(42);
    }
  });

  it("abstains safely when the model itself abstains, without tripping the breaker", async () => {
    const breaker = new CircuitBreaker(2);
    const adapter = new DeterministicStubAdapter("claude-x", { raw: validRaw({ abstain: true, abstainReason: "thin packet" }) });
    const result = await runAssessment(opts(adapter, { breaker }));
    expect(result).toMatchObject({ outcome: "abstained", code: "MODEL_ABSTAINED" });
    expect(result.record.validation).toBe("abstained");
    expect(breaker.isOpen()).toBe(false);
  });

  it("abstains and records invalid on unresolved citations or factor mismatch, and trips the breaker", async () => {
    const breaker = new CircuitBreaker(1);
    const adapter = new DeterministicStubAdapter("claude-x", { raw: validRaw({ evidenceFor: [{ sourceId: "obs-999", fact: "made up" }] }) });
    const result = await runAssessment(opts(adapter, { breaker }));
    expect(result).toMatchObject({ outcome: "abstained", code: "INVALID_OUTPUT" });
    expect(result.record.validation).toBe("invalid");
    expect(breaker.isOpen()).toBe(true);
  });

  it("abstains on a silent model swap (served id != pinned id)", async () => {
    const adapter = new DeterministicStubAdapter("claude-x", { raw: validRaw(), servedModelId: "claude-y" });
    const result = await runAssessment(opts(adapter));
    expect(result).toMatchObject({ outcome: "abstained", code: "MODEL_ID_MISMATCH" });
  });

  it("abstains on a deadline breach", async () => {
    const adapter = new DeterministicStubAdapter("claude-x", { raw: validRaw(), delayMs: 60 });
    const result = await runAssessment(opts(adapter, { deadlineMs: 10 }));
    expect(result).toMatchObject({ outcome: "abstained", code: "DEADLINE_EXCEEDED" });
  });

  it("retries a transient failure and then succeeds", async () => {
    const adapter = new DeterministicStubAdapter("claude-x", { raw: validRaw(), failFirst: 1 });
    const result = await runAssessment(opts(adapter, { maxAttempts: 2, breaker: new CircuitBreaker(3) }));
    expect(result.outcome).toBe("assessed");
    expect(result.record.attempts).toBe(2);
  });

  it("abstains and opens the breaker when all attempts fail", async () => {
    const breaker = new CircuitBreaker(2);
    const adapter = new DeterministicStubAdapter("claude-x", { alwaysFail: true });
    const result = await runAssessment(opts(adapter, { maxAttempts: 2, breaker }));
    expect(result).toMatchObject({ outcome: "abstained", code: "MODEL_UNAVAILABLE" });
    expect(breaker.isOpen()).toBe(true);
  });

  it("stops new analysis when the daily budget is exhausted, without calling the provider", async () => {
    const adapter = new DeterministicStubAdapter("claude-x", { raw: validRaw() });
    const result = await runAssessment(opts(adapter, { budget: budget({ spentTodayUsd: new Dec("5.00") }) }));
    expect(result).toMatchObject({ outcome: "abstained", code: "BUDGET_EXCEEDED" });
    expect(result.record.attempts).toBe(0);
  });

  it("does not call the provider while the breaker is open", async () => {
    const breaker = new CircuitBreaker(1);
    breaker.recordFailure();
    const adapter = new DeterministicStubAdapter("claude-x", { raw: validRaw() });
    const result = await runAssessment(opts(adapter, { breaker }));
    expect(result).toMatchObject({ outcome: "abstained", code: "CIRCUIT_OPEN" });
    expect(result.record.attempts).toBe(0);
  });
});
