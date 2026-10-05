import { addDays, type Dec, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import { isWeeklyDecisionSession } from "./shadow-job.ts";
import type { ShadowFillRecord } from "./shadow-fills.ts";

/**
 * The shadow reconciler (D-53 slice 3b): deterministic break detection over the two append-only ledgers the
 * shadow loop writes - sealed decision records and counterfactual fill records - plus the replayed synthetic
 * book. It is the rung-2 exit evidence check made continuous: "zero missing decision records" is a property
 * someone must actually measure, every week, not assert at promotion time.
 *
 * Pure: every input is passed in; it reads no config, clock, or database and writes nothing. The caller (the
 * shadow fill job) persists the breaks as ledger events. With no broker there is nothing external to reconcile
 * against - these are INTERNAL consistency breaks; broker-truth reconciliation arrives with slice 4's paper
 * adapter and reuses this seam.
 *
 * Break code vocabulary (stable strings - notify and tests key on them):
 *  - `MISSING_DECISION_RECORD:<arm>:<session>` - a weekly decision session inside the observed window has no
 *    sealed record for an arm that has sealed before. Rung 2's exit evidence is dead on arrival if these exist.
 *  - `MISSING_FILL_RECORD:<arm>:<decisionAt>` - a sealed decision whose fill-due session has passed with no
 *    recorded outcome.
 *  - `UNFILLED_REMAINDER:<arm>:<decisionAt>:<entityId>` - the simulator could not fill an order's full
 *    quantity inside its fill window (thin volume, untradable bars, or cash exhaustion).
 *  - `NEGATIVE_CASH:<arm>:<session>` - the replayed synthetic book went cash-negative: an invariant violation
 *    in the fill application, never expected.
 */

/** The fill-due session: `delayBars` sessions after the decision session (the first fill attempt's session). */
export function fillDueSession(calendar: ExchangeCalendar, decisionSession: IsoDate, delayBars: number): IsoDate {
  if (delayBars <= 0) return decisionSession;
  // 8/5 calendar days per session plus slack, same integer-only margin the feature window uses.
  const horizon = addDays(decisionSession, Math.ceil((delayBars * 8) / 5) + 14);
  const sessions = calendar.sessionDates(decisionSession, horizon);
  const due = sessions[delayBars];
  if (due === undefined) throw new RangeError(`no session ${delayBars} sessions after ${decisionSession} within ${horizon}`);
  return due;
}

export type SealedDecisionKey = { arm: string; decisionAt: UtcInstant; decisionSession: IsoDate };

export type ReconcileShadowInput = {
  calendar: ExchangeCalendar;
  /** Every arm the charter seals; a session is complete only when each has a record. */
  arms: readonly string[];
  /** Every sealed decision record's identity, from the decision ledger. */
  sealed: readonly SealedDecisionKey[];
  /** Every persisted counterfactual fill record. */
  fillRecords: readonly ShadowFillRecord[];
  /** The last completed session the reconciler may treat as observable. */
  throughSession: IsoDate;
  /** The charter's execution delay in sessions (fills land this many sessions after the decision). */
  delayBars: number;
  /** The simulator's fill-window length in bars; an outcome is OWED only once the whole window has completed. */
  maxFillBars: number;
  /** Replayed synthetic book cash per arm, by session, for the invariant check. */
  bookCash: ReadonlyMap<string, readonly { session: IsoDate; cash: Dec }[]>;
};

/** Deterministic internal-consistency breaks over the shadow ledgers. Empty means clean. */
export function reconcileShadow(input: ReconcileShadowInput): string[] {
  const breaks: string[] = [];

  // The observed window opens at the first session ANY arm sealed: before that the loop was not running, and
  // a window keyed per arm would let an arm that never sealed erase its own gaps.
  const firstSession = input.sealed.map((s) => s.decisionSession).sort()[0];
  if (firstSession !== undefined) {
    const sealedBy = new Map<string, Set<IsoDate>>();
    for (const s of input.sealed) {
      const set = sealedBy.get(s.arm) ?? new Set<IsoDate>();
      set.add(s.decisionSession);
      sealedBy.set(s.arm, set);
    }
    if (firstSession <= input.throughSession) {
      // Weekly decision sessions judged per session with the forward-looking rule (`isWeeklyDecisionSession`),
      // never by running the window-scoped enumeration over a truncated window: that treats the window's last
      // session as its week's decision session even mid-week, which would flag phantom gaps on every weekday.
      for (const session of input.calendar.sessionDates(firstSession, input.throughSession)) {
        if (!isWeeklyDecisionSession(input.calendar, session)) continue;
        for (const arm of input.arms) {
          if (!(sealedBy.get(arm)?.has(session) ?? false)) breaks.push(`MISSING_DECISION_RECORD:${arm}:${session}`);
        }
      }
    }
  }

  // An outcome is owed only after the simulator's WHOLE fill window has completed: the fill job legitimately
  // defers finalizing a working remainder until the window's last bar is observable, so flagging at the first
  // attempt session would raise a phantom incident on every deferred order.
  const filled = new Set(input.fillRecords.map((f) => `${f.arm}|${f.decisionAt}`));
  for (const s of input.sealed) {
    if (filled.has(`${s.arm}|${s.decisionAt}`)) continue;
    if (fillDueSession(input.calendar, s.decisionSession, input.delayBars + input.maxFillBars - 1) <= input.throughSession) {
      breaks.push(`MISSING_FILL_RECORD:${s.arm}:${s.decisionAt}`);
    }
  }

  for (const f of input.fillRecords) {
    // A CASH remainder is the book's own arithmetic, not a data or liquidity break: whole-share flooring at
    // the decision price plus an adverse open routinely leaves the last share unaffordable, and flagging that
    // every week would bury the breaks that matter. Liquidity and missing-bars remainders stay breaks.
    for (const u of f.unfilled) {
      if (u.reason !== "CASH") breaks.push(`UNFILLED_REMAINDER:${f.arm}:${f.decisionAt}:${u.entityId}`);
    }
  }

  for (const [arm, points] of [...input.bookCash].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const p of points) {
      if (p.cash.isNegative()) breaks.push(`NEGATIVE_CASH:${arm}:${p.session}`);
    }
  }

  return breaks.sort();
}
