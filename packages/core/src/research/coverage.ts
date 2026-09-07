import { addDays, hashJson, type IsoDate, type UtcInstant } from "@blackgold/shared";
import type { ExchangeCalendar } from "../calendar/types.ts";
import { isQualityCode, QUALITY_RULES } from "../data/quality.ts";
import type { ReadOnlyPointInTime } from "../data/pit/types.ts";
import { DEFAULT_BARS_SOURCE_ID, RawSeries } from "../market/series.ts";
import { corporateActionFromValue, corporateActionSourceId, CORPORATE_ACTION_KINDS } from "../market/types.ts";

/**
 * Coverage report (PLAN.md Phase 2, docs/EXPERIMENT_PROTOCOL.md section 2: the registration freezes
 * "snapshot IDs for every dataset, plus the coverage report ID").
 *
 * The report answers one question per entity: for the sessions this evaluation window covers, which bars
 * exist, which are missing, which are not tradable, and which carry a quality code that bars a decision or
 * bars promotion evidence. A registered experiment cites the report id, so "we did not notice the data was
 * thin" stops being available as an explanation after the fact.
 *
 * Coverage is measured as of a stated instant, through `asOf`, exactly as a decision would see it. A report
 * built from the current table instead of a point-in-time read would overstate what a historical decision
 * could have known.
 */

export const COVERAGE_REPORT_VERSION = 1;

export type EntityCoverage = {
  entityId: string;
  /** First and last session with a bar inside the window, or undefined when nothing is covered. */
  firstSession: IsoDate | undefined;
  lastSession: IsoDate | undefined;
  /** Exchange sessions in the window. */
  expectedSessions: number;
  /** Sessions with a bar. */
  coveredSessions: number;
  /** Sessions inside the entity's own covered span with no bar. */
  interiorGaps: IsoDate[];
  /** Window sessions before the entity's first bar: history the entity simply does not have. */
  leadingAbsent: number;
  /** Window sessions after the entity's last bar. */
  trailingAbsent: number;
  /** Bars retained for continuity but not tradable (STALE_BAR). */
  staleBars: number;
  /** Quality code counts across the entity's bars. */
  qualityCounts: Record<string, number>;
  /** Corporate actions visible in the window, by kind. */
  actionCounts: Record<string, number>;
  /** Coverage of the window as a ratio in [0, 1], to 6 decimal places, as a string. */
  coverageRatio: string;
  /** Codes present that bar a row from decisions or bar the run from promotion evidence. */
  blockingCodes: string[];
};

export type CoverageReport = {
  reportId: string;
  version: number;
  asOfDecisionAt: UtcInstant;
  from: IsoDate;
  to: IsoDate;
  barsSourceId: string;
  snapshotId: string | undefined;
  expectedSessions: number;
  entities: EntityCoverage[];
  /** Entities with no bar at all in the window. */
  uncovered: string[];
  /** Entities whose coverage ratio is below the stated minimum. */
  belowMinimum: string[];
  /** Union of codes that would bar promotion evidence. */
  promotionBlockingCodes: string[];
  labels: string[];
  reportHash: string;
};

export type CoverageInput = {
  pit: ReadOnlyPointInTime;
  calendar: ExchangeCalendar;
  entities: readonly string[];
  from: IsoDate;
  to: IsoDate;
  /** Read the window as it looked at this instant. Normally the end of the evaluation window. */
  decisionAt: UtcInstant;
  barsSourceId?: string;
  snapshotId?: string;
  processingDelayMs?: number;
  /** Coverage ratio below which an entity is listed in `belowMinimum`. Default "0.98". */
  minimumCoverageRatio?: string;
};

function ratioString(covered: number, expected: number): string {
  if (expected === 0) return "0.000000";
  // Integer arithmetic then a fixed-point string: no float literal touches this.
  const scaled = Math.round((covered * 1_000_000) / expected);
  const whole = Math.floor(scaled / 1_000_000);
  const frac = String(scaled % 1_000_000).padStart(6, "0");
  return `${whole}.${frac}`;
}

export function buildCoverageReport(input: CoverageInput): CoverageReport {
  if (input.to < input.from) throw new RangeError(`coverage window ends (${input.to}) before it starts (${input.from})`);
  const barsSourceId = input.barsSourceId ?? DEFAULT_BARS_SOURCE_ID;
  const sessions = input.calendar.sessionDates(input.from, input.to);
  const expected = sessions.length;
  const minimum = input.minimumCoverageRatio ?? "0.98";
  const labels = new Set<string>();
  const entities: EntityCoverage[] = [];

  for (const entityId of [...input.entities].sort()) {
    const raw = RawSeries.load({
      pit: input.pit,
      entityId,
      from: input.from,
      to: input.to,
      decisionAt: input.decisionAt,
      calendar: input.calendar,
      sourceId: barsSourceId,
      ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
      ...(input.processingDelayMs === undefined ? {} : { processingDelayMs: input.processingDelayMs }),
    });
    for (const l of raw.labels) labels.add(l);

    const qualityCounts: Record<string, number> = {};
    let staleBars = 0;
    for (const bar of raw.bars) {
      if (!bar.tradable) staleBars++;
      for (const flag of bar.flags) qualityCounts[flag] = (qualityCounts[flag] ?? 0) + 1;
    }

    const actionCounts: Record<string, number> = {};
    for (const kind of CORPORATE_ACTION_KINDS) {
      const res = input.pit.asOf({
        sourceId: corporateActionSourceId(kind),
        entityId,
        decisionAt: input.decisionAt,
        ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
        ...(input.processingDelayMs === undefined ? {} : { processingDelayMs: input.processingDelayMs }),
      });
      for (const l of res.labels) labels.add(l);
      let n = 0;
      for (const row of res.rows) {
        const a = corporateActionFromValue(row.value);
        const d = actionEffective(a);
        if (d >= input.from && d <= input.to) n++;
      }
      if (n > 0) actionCounts[kind] = n;
    }

    const first = raw.bars[0]?.session;
    const last = raw.bars[raw.bars.length - 1]?.session;
    const leading = first === undefined ? expected : input.calendar.sessionDates(input.from, addDays(first, -1)).length;
    const trailing = last === undefined ? 0 : input.calendar.sessionDates(addDays(last, 1), input.to).length;
    const blocking = [...new Set([...Object.keys(qualityCounts), ...(staleBars > 0 ? ["STALE_BAR"] : [])])]
      .filter(isQualityCode)
      .filter((c) => !QUALITY_RULES[c].decisionAllowed || !QUALITY_RULES[c].promotionEvidenceAllowed)
      .sort();

    entities.push({
      entityId,
      firstSession: first,
      lastSession: last,
      expectedSessions: expected,
      coveredSessions: raw.bars.length,
      interiorGaps: raw.gaps,
      leadingAbsent: leading,
      trailingAbsent: trailing,
      staleBars,
      qualityCounts,
      actionCounts,
      coverageRatio: ratioString(raw.bars.length, expected),
      blockingCodes: blocking,
    });
  }

  const uncovered = entities.filter((e) => e.coveredSessions === 0).map((e) => e.entityId);
  const belowMinimum = entities.filter((e) => e.coveredSessions > 0 && e.coverageRatio < minimum).map((e) => e.entityId);
  const promotionBlocking = [...new Set(entities.flatMap((e) => e.blockingCodes))]
    .filter(isQualityCode)
    .filter((c) => !QUALITY_RULES[c].promotionEvidenceAllowed)
    .sort();

  const body = {
    version: COVERAGE_REPORT_VERSION,
    asOfDecisionAt: input.decisionAt,
    from: input.from,
    to: input.to,
    barsSourceId,
    snapshotId: input.snapshotId,
    expectedSessions: expected,
    entities,
    uncovered,
    belowMinimum,
    promotionBlockingCodes: promotionBlocking,
    labels: [...labels].sort(),
  };
  const hash = hashJson(body);
  return { reportId: `cov_${input.to.replaceAll("-", "")}_${hash.slice(0, 8)}`, ...body, reportHash: `sha256:${hash}` };
}

function actionEffective(a: ReturnType<typeof corporateActionFromValue>): IsoDate {
  switch (a.kind) {
    case "SPLIT":
    case "CASH_DIVIDEND":
    case "SPINOFF":
      return a.exDate;
    case "SYMBOL_CHANGE":
    case "MERGER":
      return a.effective;
    case "DELISTING":
      return a.lastTradeDate;
    case "STALE_BAR":
    case "CORRECTED_BAR":
      return a.session;
  }
}
