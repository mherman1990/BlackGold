import { describe, expect, it } from "vitest";
import { ORDER_STATES, type OrderState } from "@blackgold/shared";
import {
  IllegalTransitionError,
  LEGAL_TRANSITIONS,
  TERMINAL_STATES,
  assertTransition,
  isLegalTransition,
  isTerminal,
  legalTransitionList,
} from "../src/index.ts";

/**
 * The legal table, written out. Any change to src/state-machine/transitions.ts must change this list too,
 * so the diff is visible in review. Sorted lexically as "FROM->TO".
 */
const EXPECTED_LEGAL = [
  "ACKNOWLEDGED->CANCEL_PENDING",
  "ACKNOWLEDGED->FILLED",
  "ACKNOWLEDGED->PARTIALLY_FILLED",
  "ACKNOWLEDGED->UNKNOWN",
  "APPROVED->CANCELED",
  "APPROVED->SUBMITTING",
  "AWAITING_APPROVAL->APPROVED",
  "AWAITING_APPROVAL->CANCELED",
  "AWAITING_APPROVAL->REJECTED",
  "CANCEL_PENDING->CANCELED",
  "CANCEL_PENDING->FILLED",
  "CANCEL_PENDING->PARTIALLY_FILLED",
  "CANCEL_PENDING->UNKNOWN",
  "CREATED->REJECTED",
  "CREATED->VALIDATED",
  "EXIT_PENDING->CLOSED",
  "EXIT_PENDING->PARTIALLY_FILLED",
  "EXIT_PENDING->UNKNOWN",
  "FILLED->CLOSED",
  "FILLED->PROTECTION_PENDING",
  "PARTIALLY_FILLED->CANCEL_PENDING",
  "PARTIALLY_FILLED->FILLED",
  "PARTIALLY_FILLED->PARTIALLY_FILLED",
  "PARTIALLY_FILLED->PROTECTION_PENDING",
  "PARTIALLY_FILLED->UNKNOWN",
  "PROTECTED->EXIT_PENDING",
  "PROTECTED->PROTECTION_PENDING",
  "PROTECTION_FAILED->EXIT_PENDING",
  "PROTECTION_FAILED->PROTECTION_PENDING",
  "PROTECTION_PENDING->PROTECTED",
  "PROTECTION_PENDING->PROTECTION_FAILED",
  "PROTECTION_PENDING->UNKNOWN",
  "SUBMITTING->ACKNOWLEDGED",
  "SUBMITTING->REJECTED",
  "SUBMITTING->UNKNOWN",
  "UNKNOWN->ACKNOWLEDGED",
  "UNKNOWN->CANCELED",
  "UNKNOWN->FILLED",
  "UNKNOWN->PARTIALLY_FILLED",
  "UNKNOWN->REJECTED",
  "VALIDATED->APPROVED",
  "VALIDATED->AWAITING_APPROVAL",
  "VALIDATED->REJECTED",
] as const;

const EXPECTED = new Set<string>(EXPECTED_LEGAL);

describe("order state transition table", () => {
  it("matches the reviewed snapshot exactly", () => {
    expect(legalTransitionList()).toEqual([...EXPECTED_LEGAL]);
    expect(EXPECTED_LEGAL.length).toBe(43);
  });

  it("has an entry for every OrderState and nothing else", () => {
    expect([...LEGAL_TRANSITIONS.keys()].sort()).toEqual([...ORDER_STATES].sort());
  });

  it("is exhaustive: every (from, to) pair is legal iff it is in the table", () => {
    let checked = 0;
    for (const from of ORDER_STATES) {
      for (const to of ORDER_STATES) {
        const legal = EXPECTED.has(`${from}->${to}`);
        expect(isLegalTransition(from, to), `${from}->${to}`).toBe(legal);
        if (legal) {
          expect(() => {
            assertTransition(from, to);
          }).not.toThrow();
        } else {
          expect(() => {
            assertTransition(from, to);
          }).toThrow(IllegalTransitionError);
        }
        checked++;
      }
    }
    expect(checked).toBe(ORDER_STATES.length * ORDER_STATES.length);
  });

  it("terminal states have no outgoing transitions and only they are terminal", () => {
    const terminals: OrderState[] = ["CLOSED", "CANCELED", "REJECTED"];
    expect([...TERMINAL_STATES].sort()).toEqual([...terminals].sort());
    for (const s of ORDER_STATES) {
      const out = LEGAL_TRANSITIONS.get(s);
      expect(out).toBeDefined();
      if (terminals.includes(s)) {
        expect(isTerminal(s)).toBe(true);
        expect(out?.size).toBe(0);
      } else {
        expect(isTerminal(s)).toBe(false);
        expect(out?.size ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("names both ends of an illegal transition in the error", () => {
    try {
      assertTransition("CLOSED", "CREATED");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      if (err instanceof IllegalTransitionError) {
        expect(err.from).toBe("CLOSED");
        expect(err.to).toBe("CREATED");
      }
    }
  });
});
