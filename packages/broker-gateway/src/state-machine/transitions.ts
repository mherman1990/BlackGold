import { ORDER_STATES, type OrderState } from "@blackgold/shared";

/**
 * LEGAL TRANSITION TABLE for the persisted order lifecycle (docs/PRODUCT_SPEC.md section 10).
 * Any (from, to) pair not present here is illegal and `assertTransition` throws.
 *
 * Side conditions the table alone cannot express are enforced by OrderStore.transition:
 *   - UNKNOWN -> * happens only through reconciliation against broker truth (reason prefix "reconciliation:").
 *   - FILLED -> CLOSED is legal only for exits (side SELL); a filled entry must go through protection.
 *   - PROTECTED -> PROTECTION_PENDING is the re-protect path after a corporate action.
 */
const TABLE: readonly (readonly [OrderState, readonly OrderState[]])[] = [
  ["CREATED", ["VALIDATED", "REJECTED"]],
  ["VALIDATED", ["AWAITING_APPROVAL", "APPROVED", "REJECTED"]],
  ["AWAITING_APPROVAL", ["APPROVED", "REJECTED", "CANCELED"]],
  ["APPROVED", ["SUBMITTING", "CANCELED"]],
  ["SUBMITTING", ["ACKNOWLEDGED", "REJECTED", "UNKNOWN"]],
  ["UNKNOWN", ["ACKNOWLEDGED", "REJECTED", "PARTIALLY_FILLED", "FILLED", "CANCELED"]],
  ["ACKNOWLEDGED", ["PARTIALLY_FILLED", "FILLED", "CANCEL_PENDING", "UNKNOWN"]],
  ["PARTIALLY_FILLED", ["PARTIALLY_FILLED", "FILLED", "CANCEL_PENDING", "PROTECTION_PENDING", "UNKNOWN"]],
  ["FILLED", ["PROTECTION_PENDING", "CLOSED"]],
  ["PROTECTION_PENDING", ["PROTECTED", "PROTECTION_FAILED", "UNKNOWN"]],
  ["PROTECTION_FAILED", ["PROTECTION_PENDING", "EXIT_PENDING"]],
  ["PROTECTED", ["EXIT_PENDING", "PROTECTION_PENDING"]],
  ["CANCEL_PENDING", ["CANCELED", "FILLED", "PARTIALLY_FILLED", "UNKNOWN"]],
  ["EXIT_PENDING", ["CLOSED", "UNKNOWN", "PARTIALLY_FILLED"]],
  ["CLOSED", []],
  ["CANCELED", []],
  ["REJECTED", []],
];

export const LEGAL_TRANSITIONS: ReadonlyMap<OrderState, ReadonlySet<OrderState>> = new Map(
  TABLE.map(([from, tos]) => [from, new Set(tos)] as const),
);

// Every state must have an entry, even terminal ones (with an empty set), so lookups never miss.
for (const s of ORDER_STATES) {
  if (!LEGAL_TRANSITIONS.has(s)) throw new Error(`transition table is missing state ${s}`);
}

export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set<OrderState>(["CLOSED", "CANCELED", "REJECTED"]);

export class IllegalTransitionError extends Error {
  readonly from: OrderState;
  readonly to: OrderState;
  constructor(from: OrderState, to: OrderState, detail?: string) {
    super(`Illegal order transition ${from} -> ${to}${detail ? `: ${detail}` : ""}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isLegalTransition(from: OrderState, to: OrderState): boolean {
  return LEGAL_TRANSITIONS.get(from)?.has(to) ?? false;
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!isLegalTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Sorted "FROM->TO" strings; used by the exhaustive table test so any change is visible in review. */
export function legalTransitionList(): string[] {
  const out: string[] = [];
  for (const [from, tos] of LEGAL_TRANSITIONS) for (const to of tos) out.push(`${from}->${to}`);
  return out.sort();
}
