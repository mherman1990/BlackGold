import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Dec, ONE, addDays, isoDate, sha256Hex, utc, type Db, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { NyseCalendar } from "../src/calendar/nyse.ts";
import { loadCharterFile, type Charter } from "../src/strategy/charter.ts";
import { openCoreDb } from "../src/db/open.ts";
import { PointInTimeRepository } from "../src/data/pit/repository.ts";
import { DEFAULT_BARS_SOURCE_ID } from "../src/market/series.ts";
import { corporateActionObservation, rawBarToValue, type CorporateAction, type RawBar } from "../src/market/types.ts";
import type { PointInTimeObservation } from "../src/data/pit/types.ts";

/**
 * A synthetic market for Phase 2 tests: deterministic price paths on real NYSE sessions, appended through
 * the point-in-time repository with the same 30-minute publication delay the charter assumes.
 *
 * Deterministic by construction. Every price comes from a closed-form geometric path, so a test can state
 * exactly which ETF should rank first and why, and a rule change shows up as a failing assertion rather
 * than as a plausible-looking number.
 */
export const BARS_PUBLISH_DELAY_MS = 30 * 60_000;
const ADAPTER_VERSION = "1.0.0";

export type PricePath = {
  entityId: string;
  /** Close on the first session. */
  start: Dec;
  /** Multiplicative per-session drift, e.g. "1.0005" for a steady riser. */
  perSession: Dec;
  /** Daily dollar volume is `volumeShares` x close. */
  volumeShares: bigint;
  /** Alternating +/- wobble applied to the close, as a fraction. Keeps the volatility estimator non-zero. */
  wobble?: Dec;
};

export type FixtureMarket = {
  db: Db;
  pit: PointInTimeRepository;
  calendar: NyseCalendar;
  sessions: IsoDate[];
  /** Session close + 60 minutes, the charter's decision timestamp. */
  decisionAt(session: IsoDate): UtcInstant;
  /** Every Friday-equivalent (last session of its exchange week) in the fixture range. */
  weeklyDecisionSessions(): IsoDate[];
  closeOf(entityId: string, session: IsoDate): Dec | undefined;
};

/**
 * The registered charter, read and validated once, handed out as a fresh deep clone.
 *
 * Every heavy suite starts from this one file and then shortens its feature windows, so the YAML read and
 * the schema parse behind `loadCharterFile` were paid dozens of times per run for a document that cannot
 * change between two tests. Loading and validating a charter is covered by strategy-charter.test.ts; here it
 * is fixture plumbing. The clone is what callers get, so a suite is still free to mutate its own copy.
 */
let parsedCharter: Charter | undefined;
export function fixtureCharter(): Charter {
  parsedCharter ??= loadCharterFile(fileURLToPath(new URL("../../../strategies/etf-trend-vol/charter.yaml", import.meta.url))).charter;
  return structuredClone(parsedCharter);
}

export function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "bg-strategy-"));
  return openCoreDb({ dbPath: join(dir, "s.sqlite") }).db;
}

/** Path close on session index `i`: start x perSession^i, with an alternating wobble. */
export function pathClose(p: PricePath, i: number): Dec {
  const base = p.start.times(p.perSession.pow(i));
  const w = p.wobble;
  if (w === undefined) return base;
  return base.times(ONE.plus(i % 2 === 0 ? w : w.negated()));
}

export type BuildMarketOptions = {
  paths: readonly PricePath[];
  from: IsoDate;
  to: IsoDate;
  /** Sessions to record a STALE_BAR against, per entity. */
  staleSessions?: Readonly<Record<string, readonly IsoDate[]>>;
  /** Sessions to omit entirely, per entity, creating a GAP. */
  omitSessions?: Readonly<Record<string, readonly IsoDate[]>>;
  actions?: readonly { action: CorporateAction; availableAt?: UtcInstant; qualityFlags?: readonly string[]; sourceLocator?: string }[];
  /** Set the row's availableAt to the session close plus this many ms. Defaults to 30 minutes. */
  publishDelayMs?: number;
  /**
   * Per-entity open as a fraction of the same session's close, e.g. "0.99" to open 1% below it. Absent
   * entities open at their close.
   *
   * Two things a test exercising an open-split benchmark needs to know. The default (`open = close`) makes
   * every session's move entirely overnight, so a benchmark that decomposes a session at the open is
   * indistinguishable from one that does not. And a ratio applied UNIFORMLY across entities is no better: the
   * intraday factor is then the same on every leg, so a blend of them is weight-independent and the split
   * cancels out exactly. Give the legs DIFFERENT ratios.
   */
  openRatio?: Readonly<Record<string, Dec>>;
  db?: Db;
};

export function buildMarket(opts: BuildMarketOptions): FixtureMarket {
  const db = opts.db ?? fixtureDb();
  const calendar = new NyseCalendar();
  const ingestedAt = utc("2026-09-07T00:00:00Z");
  const pit = new PointInTimeRepository(db, { clock: () => Date.parse(ingestedAt) });
  const sessions = calendar.sessionDates(opts.from, opts.to);
  const delay = opts.publishDelayMs ?? BARS_PUBLISH_DELAY_MS;
  const closes = new Map<string, Map<string, Dec>>();

  // One transaction for the whole seed, not one per row. `openDatabase` runs SQLite at `synchronous = FULL`,
  // so a bare `pit.append` is its own commit and its own fsync; a six-month ten-symbol fixture is ~1250 of
  // them and paid over a second for the durability of a temp file the test deletes. `Db.transaction` is
  // savepoint-aware, so the repository's own per-append transaction nests inside this one and the append
  // path under test is unchanged. Halves the build cost of every fixture market in the suite.
  db.transaction(() => {
    for (const p of opts.paths) {
      const omitted = new Set(opts.omitSessions?.[p.entityId] ?? []);
      const perEntity = new Map<string, Dec>();
      closes.set(p.entityId, perEntity);
      const stale = new Set(opts.staleSessions?.[p.entityId] ?? []);
      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        if (session === undefined || omitted.has(session)) continue;
        const close = pathClose(p, i);
        perEntity.set(session, close);
        const ratio = opts.openRatio?.[p.entityId];
        const open = ratio === undefined ? close : close.times(ratio);
        const bar: RawBar = {
          symbol: p.entityId,
          session,
          open,
          high: open.gt(close) ? open : close,
          low: open.lt(close) ? open : close,
          close,
          volume: p.volumeShares,
          venue: "iex",
        };
        const availableAt = utc(Date.parse(calendar.sessionClose(session)) + delay);
        const obs: PointInTimeObservation<Record<string, unknown>> = {
          sourceId: DEFAULT_BARS_SOURCE_ID,
          sourceLocator: `${DEFAULT_BARS_SOURCE_ID}/${p.entityId}/${session}`,
          entityId: p.entityId,
          effectiveAt: utc(`${session}T00:00:00Z`),
          availableAt,
          ingestedAt,
          rawContentHash: `sha256:${sha256Hex(`${p.entityId}:${session}:${open.toFixed()}:${close.toFixed()}`)}`,
          adapterVersion: ADAPTER_VERSION,
          parserVersion: ADAPTER_VERSION,
          value: rawBarToValue(bar),
          qualityFlags: [],
        };
        pit.append(obs);
        if (stale.has(session)) {
          pit.append(
            corporateActionObservation(
              { kind: "STALE_BAR", entityId: p.entityId, session, reason: "provider repeated the prior close" },
              {
                sourceLocator: `fixture/stale/${p.entityId}/${session}`,
                availableAt,
                ingestedAt,
                rawContentHash: `sha256:${sha256Hex(`stale:${p.entityId}:${session}`)}`,
                adapterVersion: ADAPTER_VERSION,
                parserVersion: ADAPTER_VERSION,
              },
            ),
          );
        }
      }
    }

    for (const entry of opts.actions ?? []) {
      pit.append(
        corporateActionObservation(entry.action, {
          sourceLocator: entry.sourceLocator ?? `fixture/action/${entry.action.kind}/${JSON.stringify(entry.action).length}`,
          availableAt: entry.availableAt ?? utc(`${actionDate(entry.action)}T00:00:00Z`),
          ingestedAt,
          rawContentHash: `sha256:${sha256Hex(`action:${JSON.stringify(entry.action)}`)}`,
          adapterVersion: ADAPTER_VERSION,
          parserVersion: ADAPTER_VERSION,
          ...(entry.qualityFlags === undefined ? {} : { qualityFlags: [...entry.qualityFlags] }),
        }),
      );
    }
  });

  return {
    db,
    pit,
    calendar,
    sessions,
    decisionAt: (session) => utc(Date.parse(calendar.sessionClose(session)) + 60 * 60_000),
    weeklyDecisionSessions: () => weekEndSessions(sessions),
    closeOf: (entityId, session) => closes.get(entityId)?.get(session),
  };
}

function actionDate(a: CorporateAction): IsoDate {
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

/** The last session of each exchange week: the charter's weekly decision cadence. */
export function weekEndSessions(sessions: readonly IsoDate[]): IsoDate[] {
  const out: IsoDate[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const cur = sessions[i];
    const next = sessions[i + 1];
    if (cur === undefined) continue;
    if (next === undefined || weekKey(next) !== weekKey(cur)) out.push(cur);
  }
  return out;
}

/** ISO week bucket: the Monday of the session's week. */
function weekKey(session: IsoDate): string {
  const dow = new Date(`${session}T00:00:00Z`).getUTCDay();
  const backToMonday = dow === 0 ? -6 : 1 - dow;
  return addDays(session, backToMonday);
}

export const D = (s: string): IsoDate => isoDate(s);
export const N = (s: string): Dec => new Dec(s);
