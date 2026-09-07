import { addDays, hashJson, isoDate, type IsoDate } from "@blackgold/shared";
import type { Charter } from "../strategy/charter.ts";

/**
 * Time-ordered walk-forward splits with purging and embargo (docs/EXPERIMENT_PROTOCOL.md sections 5.1, 5.2).
 *
 * Market observations are never shuffled into folds. A split is a contiguous evaluation window preceded by a
 * contiguous design window, separated by a purge (observations whose feature or holding windows overlap the
 * boundary) and an embargo (a gap after the purge). The charter freezes the window length, step, purge and
 * embargo, so no boundary can be shopped for after a result is seen.
 *
 * The final holdout is produced as a closed descriptor. `holdoutSplit` returns it only with an explicit
 * `opened` flag, and `walkForwardSplits` never includes holdout dates in any evaluation window, so the
 * default behaviour of every runner is to leave the holdout untouched.
 */

export const WALK_FORWARD_VERSION = 1;

export type SplitKind = "DESIGN" | "WALK_FORWARD" | "RECENT" | "HOLDOUT";

export type Split = {
  /** Stable label used as the trial ledger's `split` column. */
  id: string;
  kind: SplitKind;
  /** The design window a runner may look at. Absent for a pure evaluation segment. */
  design: { start: IsoDate; end: IsoDate } | undefined;
  /** The evaluation window. Results come only from here. */
  evaluation: { start: IsoDate; end: IsoDate };
  /** Sessions dropped between design end and evaluation start: purge then embargo. */
  purgeDays: number;
  embargoDays: number;
};

export type WalkForwardParams = {
  windowYears: number;
  stepMonths: number;
  purgeDays: number;
  embargoDays: number;
};

export function walkForwardParamsFromCharter(c: Charter): WalkForwardParams {
  return {
    windowYears: c.boundaries.walk_forward.window_years,
    stepMonths: c.boundaries.walk_forward.step_months,
    purgeDays: c.boundaries.walk_forward.purge_days,
    embargoDays: c.boundaries.walk_forward.embargo_days,
  };
}

function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new RangeError(`bad date ${date}`);
  const total = (y * 12 + (m - 1)) + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  // Clamp the day into the target month so 31 January plus one month is 28/29 February, not 3 March.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return isoDate(`${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

export class SplitRangeError extends Error {
  constructor(detail: string) {
    super(`Split range error: ${detail}`);
    this.name = "SplitRangeError";
  }
}

/**
 * Rolling walk-forward splits inside `[start, end]`.
 *
 * Each split trains on `windowYears` of history and evaluates the following `stepMonths`, then rolls forward
 * by `stepMonths`. The evaluation window begins `purgeDays + embargoDays` after the design window ends, and
 * the design window ends where the previous evaluation window did, so no calendar day is ever both designed
 * on and evaluated in. A trailing partial window is kept only when it holds at least one day.
 */
export function walkForwardSplits(range: { start: IsoDate; end: IsoDate }, params: WalkForwardParams): Split[] {
  if (range.end < range.start) throw new SplitRangeError(`${range.start} to ${range.end} runs backwards`);
  if (params.windowYears < 1) throw new SplitRangeError("windowYears must be at least 1");
  if (params.stepMonths < 1) throw new SplitRangeError("stepMonths must be at least 1");
  if (params.purgeDays < 0 || params.embargoDays < 0) throw new SplitRangeError("purge and embargo must be non-negative");

  const splits: Split[] = [];
  const gap = params.purgeDays + params.embargoDays;
  let designStart = range.start;
  for (let i = 0; ; i++) {
    const designEnd = addMonths(designStart, params.windowYears * 12);
    const evalStart = addDays(designEnd, gap + 1);
    if (evalStart > range.end) break;
    const evalEndRaw = addDays(addMonths(evalStart, params.stepMonths), -1);
    const evalEnd = evalEndRaw > range.end ? range.end : evalEndRaw;
    splits.push({
      id: `walk_forward/${evalStart}_${evalEnd}`,
      kind: "WALK_FORWARD",
      design: { start: designStart, end: designEnd },
      evaluation: { start: evalStart, end: evalEnd },
      purgeDays: params.purgeDays,
      embargoDays: params.embargoDays,
    });
    if (evalEnd >= range.end) break;
    designStart = addMonths(designStart, params.stepMonths);
    if (i > 1000) throw new SplitRangeError("walk-forward schedule did not terminate");
  }
  return splits;
}

/** The design segment as a single reportable split. */
export function designSplit(c: Charter): Split {
  const d = c.boundaries.design;
  return {
    id: `design/${d.start}_${d.end}`,
    kind: "DESIGN",
    design: { start: isoDate(d.start), end: isoDate(d.end) },
    evaluation: { start: isoDate(d.start), end: isoDate(d.end) },
    purgeDays: 0,
    embargoDays: 0,
  };
}

/** The recent quasi-forward segment, reported separately and never mixed with the design result. */
export function recentSplit(c: Charter): Split {
  const r = c.boundaries.recent;
  return {
    id: `recent/${r.start}_${r.end}`,
    kind: "RECENT",
    design: undefined,
    evaluation: { start: isoDate(r.start), end: isoDate(r.end) },
    purgeDays: 0,
    embargoDays: 0,
  };
}

export class HoldoutSealedError extends Error {
  constructor(strategyId: string) {
    super(`The holdout for ${strategyId} is sealed. Open it once, through ExperimentRegistry.openHoldout, with a written reason.`);
    this.name = "HoldoutSealedError";
  }
}

/**
 * The holdout split. Refuses to hand back the window unless the caller states the registry has already
 * opened it, so a runner cannot reach the holdout by calling one more function.
 */
export function holdoutSplit(c: Charter, opts: { opened: boolean }): Split {
  if (!opts.opened) throw new HoldoutSealedError(c.strategy_id);
  const h = c.boundaries.holdout;
  return {
    id: `holdout/${h.start}_${h.end}`,
    kind: "HOLDOUT",
    design: undefined,
    evaluation: { start: isoDate(h.start), end: isoDate(h.end) },
    purgeDays: c.boundaries.walk_forward.purge_days,
    embargoDays: c.boundaries.walk_forward.embargo_days,
  };
}

export type SplitPlan = {
  strategyId: string;
  charterVersion: string;
  /** Everything Phase 2 may evaluate: the design segment, its walk-forward schedule, and the recent segment. */
  splits: Split[];
  /** Descriptor only: dates are withheld until the registry opens it. */
  holdout: { start: IsoDate; end: IsoDate; opened: false; note: string };
  walkForwardVersion: number;
  planHash: string;
};

/**
 * The full Phase 2 evaluation plan from a charter. The holdout appears as a sealed descriptor: its dates are
 * in the charter for anyone to read, but no split in `splits` evaluates inside them, which is the property
 * the runner relies on.
 */
export function splitPlan(c: Charter): SplitPlan {
  const params = walkForwardParamsFromCharter(c);
  const splits = [designSplit(c), ...walkForwardSplits({ start: isoDate(c.boundaries.design.start), end: isoDate(c.boundaries.design.end) }, params), recentSplit(c)];
  const holdoutStart = isoDate(c.boundaries.holdout.start);
  const holdoutEnd = isoDate(c.boundaries.holdout.end);
  for (const s of splits) {
    if (s.evaluation.start <= holdoutEnd && s.evaluation.end >= holdoutStart) {
      throw new SplitRangeError(`split ${s.id} overlaps the sealed holdout ${holdoutStart} to ${holdoutEnd}`);
    }
  }
  const body = {
    strategyId: c.strategy_id,
    charterVersion: c.charter_version,
    splits,
    walkForwardVersion: WALK_FORWARD_VERSION,
  };
  return {
    ...body,
    holdout: { start: holdoutStart, end: holdoutEnd, opened: false, note: "Sealed. Opens once, via ExperimentRegistry.openHoldout, after the design and walk-forward results are reviewed." },
    planHash: `sha256:${hashJson(body)}`,
  };
}

/** Number of non-overlapping blocks of `blockSessions` in a session list: the independent-decision count. */
export function independentBlocks(sessionCount: number, blockSessions: number): number {
  if (blockSessions < 1) throw new SplitRangeError("blockSessions must be positive");
  return Math.floor(sessionCount / blockSessions);
}
