import { describe, expect, it } from "vitest";
import { utc, type UtcInstant } from "@blackgold/shared";
import type { AsOfQuery, AsOfResult, ReadOnlyPointInTime, StoredObservation } from "../src/data/pit/types.ts";
import {
  assertPacketSerializable,
  buildEvidencePacket,
  packetSourceIds,
  PacketRedactionError,
  sealPacket,
  UNTRUSTED_SOURCE_NOTICE,
  type EvidencePacket,
} from "../src/research/packet.ts";

function obs(id: number, availableAt: string, value: unknown, overrides: Partial<StoredObservation> = {}): StoredObservation {
  return {
    id,
    sourceId: "sec.submissions",
    sourceLocator: `edgar/${id}`,
    availableAt: utc(availableAt),
    ingestedAt: utc(availableAt),
    rawContentHash: `sha256:${"a".repeat(64)}`,
    adapterVersion: "1",
    parserVersion: "1",
    value,
    qualityFlags: [],
    ...overrides,
  };
}

/** A faithful stand-in for the real point-in-time read: it applies the same availableAt+delay<=decisionAt rule. */
function fakePit(rows: readonly StoredObservation[]): ReadOnlyPointInTime {
  return {
    asOf<T = unknown>(q: AsOfQuery): AsOfResult<T> {
      const delay = q.processingDelayMs ?? 0;
      const cutoff = Date.parse(q.decisionAt);
      const visible = rows.filter(
        (r) => r.sourceId === q.sourceId && Date.parse(r.availableAt) + delay <= cutoff,
      );
      return { rows: visible as StoredObservation<T>[], labels: [], processingDelayMs: delay };
    },
  };
}

function baseInput(pit: ReadOnlyPointInTime, decisionAt: string) {
  return {
    candidateId: "XLK",
    strategyId: "etf-trend-vol",
    strategyVersion: "etf-trend-vol@1",
    decisionAt: utc(decisionAt) as UtcInstant,
    pit,
    sources: [{ sourceId: "sec.submissions" }],
    excerpt: (o: StoredObservation) => String(o.value),
  };
}

describe("sealed evidence packet", () => {
  it("includes only observations available by the decision instant", () => {
    const pit = fakePit([
      obs(1, "2026-01-05T21:00:00.000Z", "past filing A"),
      obs(2, "2026-01-06T21:00:00.000Z", "past filing B"),
      obs(3, "2026-02-01T21:00:00.000Z", "FUTURE filing"),
    ]);
    const packet = buildEvidencePacket(baseInput(pit, "2026-01-10T00:00:00.000Z"));
    expect(packet.facts.map((f) => f.observationRowId)).toEqual([1, 2]);
    expect(packet.facts.some((f) => f.excerpt.includes("FUTURE"))).toBe(false);
  });

  it("excludes an observation whose availability is inside the processing delay", () => {
    const pit = fakePit([obs(1, "2026-01-10T00:00:00.000Z", "just published")]);
    const input = { ...baseInput(pit, "2026-01-10T00:10:00.000Z"), sources: [{ sourceId: "sec.submissions", processingDelayMs: 15 * 60_000 }] };
    // Available 10 minutes before the decision, but the 15-minute delay pushes it past the cutoff.
    expect(buildEvidencePacket(input).facts).toHaveLength(0);
  });

  it("maps provenance onto every fact and derives citationId from the row id", () => {
    const pit = fakePit([obs(42, "2026-01-05T21:00:00.000Z", "fact")]);
    const packet = buildEvidencePacket(baseInput(pit, "2026-01-10T00:00:00.000Z"));
    const fact = packet.facts[0];
    expect(fact).toMatchObject({
      citationId: "obs-42",
      observationRowId: 42,
      sourceId: "sec.submissions",
      sourceLocator: "edgar/42",
      rawContentHash: `sha256:${"a".repeat(64)}`,
    });
    expect(packetSourceIds(packet)).toEqual(new Set(["obs-42"]));
    expect(packet.untrustedSourceNotice).toBe(UNTRUSTED_SOURCE_NOTICE);
  });

  it("rejects a household currency total placed in a structured field (T-22)", () => {
    const packet: EvidencePacket = {
      packetVersion: 1,
      candidateId: "XLK",
      strategyId: "etf-trend-vol",
      strategyVersion: "etf-trend-vol@1",
      decisionAt: utc("2026-01-10T00:00:00.000Z"),
      untrustedSourceNotice: UNTRUSTED_SOURCE_NOTICE,
      facts: [],
      exposureFlags: [{ flag: "sleeve holds $1,250,000 in tech" }],
      restrictions: [],
    };
    expect(() => assertPacketSerializable(packet)).toThrow(PacketRedactionError);
    expect(() => sealPacket(packet)).toThrow(PacketRedactionError);
  });

  it("allows a public dollar figure inside an untrusted excerpt", () => {
    const pit = fakePit([obs(1, "2026-01-05T21:00:00.000Z", "Q3 revenue was $1,234,567,000")]);
    const packet = buildEvidencePacket(baseInput(pit, "2026-01-10T00:00:00.000Z"));
    expect(packet.facts[0]?.excerpt).toContain("$1,234,567,000");
    expect(() => assertPacketSerializable(packet)).not.toThrow();
  });

  it("rejects a secret pattern anywhere, including inside an excerpt", () => {
    const pit = fakePit([obs(1, "2026-01-05T21:00:00.000Z", "leaked key sk-ant-abc123 in the filing")]);
    expect(() => buildEvidencePacket(baseInput(pit, "2026-01-10T00:00:00.000Z"))).toThrow(PacketRedactionError);
  });

  it("seals a clean packet to a deterministic canonical form and hash", () => {
    const pit = fakePit([obs(1, "2026-01-05T21:00:00.000Z", "clean fact")]);
    const packet = buildEvidencePacket(baseInput(pit, "2026-01-10T00:00:00.000Z"));
    const first = sealPacket(packet);
    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sealPacket(packet)).toEqual(first);
  });
});
