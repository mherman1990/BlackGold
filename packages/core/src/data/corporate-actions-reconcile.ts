import { addDays, Dec, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { actionEffectiveDate, actionEntityId, corporateActionFromValue } from "../market/types.ts";
import type { PointInTimeObservation } from "./pit/types.ts";
import { corporateActionsHash } from "./adapters/corporate-actions.ts";

/**
 * Machine reconciliation of corporate actions across independent public sources (D-57, D-58).
 *
 * D-29 made the ≥2-source vendored file the only promotion-eligible corporate-action path, and D-57 lets machines
 * build it: each source's records are fetched and cross-checked here, and the result is a vendored file in
 * exactly the format `ingest corporate-actions --file` reads - but UNSIGNED. Its `approval` carries the
 * `actionsHash` of what it contains and nothing else; the owner audits the file and the report beside it and
 * signs, and ingest refuses it until he does. Claude Code is never the sole author of its own evidence base.
 *
 * **Nothing is dropped.** A dividend that only one source reports, or that two sources report differently, is
 * still a dividend the total-return series needs; leaving it out would silently understate every return that
 * spans it. So every action in the window goes into the file. One that at least two sources agree on names them
 * all in `sources`; one that they do not is written with the single source whose value it carries, which ingest
 * flags `UNVERIFIED_SINGLE_SOURCE` - so any run touching it stays uncitable - and it is listed in the report for
 * the owner to resolve. Reconciliation can make the evidence citable; it can never make it look better than it is.
 *
 * Pure: records in, file and report out. CASH_DIVIDEND and SPLIT are reconciled. Structural actions (SPINOFF,
 * MERGER, DELISTING) are a handful of cases the owner curates with their own sources (D-58): they pass through as
 * written, and any cash or split record on the same entity and date is SET ASIDE and reported rather than written,
 * because an issuer can list a spin-off in its dividend column (SSGA's XLF row of 2016-09-19 is the XLRE ratio)
 * and writing both would count one event twice. Setting aside is the one place a record does not reach the file,
 * and only ever beside the structural action that already accounts for that date.
 */
export const RECONCILE_VERSION = 2;

type SourceBase = {
  /** Written into `sources`, e.g. `vendor:tiingo-eod` or `issuer:ssga-distributions`. */
  source: string;
  entityId: string;
  exDate: IsoDate;
  /** Where the record came from (an artifact hash, URL, or document), for the report. */
  locator: string;
  /** Declaration or first public record, when the source gives one. */
  announcedAt?: UtcInstant | undefined;
};

/** A cash distribution: the TOTAL per share going ex on `exDate`, every component (income, capital gains) summed. */
export type SourceCashDividend = SourceBase & { kind: "CASH_DIVIDEND"; amount: Dec; payDate?: IsoDate | undefined };

/** A split: new shares per old share. */
export type SourceSplit = SourceBase & { kind: "SPLIT"; ratio: Dec };

export type SourceAction = SourceCashDividend | SourceSplit;

/** An owner-curated structural action, in the vendored file's entry shape (D-58). Written as given. */
export type StructuralEntry = { action: Record<string, unknown>; sources: string[]; announcedAt?: string | undefined };

const STRUCTURAL_KINDS = new Set(["SPINOFF", "MERGER", "DELISTING"]);

export type ReconcileOptions = {
  dataset: string;
  /** Inclusive ex-date window. Records outside it are ignored on every side, so a longer history is not "one-sided". */
  window: { from: IsoDate; to: IsoDate };
  /** Entities in scope. A record for any other entity is ignored. */
  entities: readonly string[];
  /**
   * The primary sources - issuers - in priority order. For each action the first of these that reports it carries
   * the file's values (amount, pay date, announcement); when sources disagree, its value is the one written,
   * single-sourced, for the owner to resolve. An action none of them reports carries the alphabetically first source.
   */
  preferredSources: readonly string[];
  /** Largest absolute per-share difference read as agreement on a cash dividend. Split ratios must match exactly. */
  amountTolerance: Dec;
  /** How far apart two ex-dates may be to be reported as a likely match. Never used to reconcile. */
  nearMatchDays?: number;
  /** Owner-curated structural actions, written as given. In-scope ones set aside same-day cash and split records. */
  structural?: readonly StructuralEntry[];
};

export const DEFAULT_AMOUNT_TOLERANCE = "0.0001";

export type ReconcileFinding = {
  entityId: string;
  kind: SourceAction["kind"];
  exDate: IsoDate;
  /** Each source's value for this key: amount or ratio as a decimal string, with its locator. */
  values: { source: string; value: string; locator: string }[];
  /** Records for the same entity and kind within `nearMatchDays` in a source that has no record on this ex-date. */
  nearMatches: { source: string; exDate: IsoDate; value: string }[];
  /** The value the file carries for it, and from which source. */
  written: { source: string; value: string };
};

export type SetAsideFinding = {
  entityId: string;
  exDate: IsoDate;
  /** The structural action that accounts for this entity and date. */
  structuralKind: string;
  /** The records not written because of it. */
  records: { source: string; kind: SourceAction["kind"]; value: string; locator: string }[];
};

export type ReconcileReport = {
  reconcileVersion: number;
  dataset: string;
  sources: string[];
  preferredSources: string[];
  window: { from: IsoDate; to: IsoDate };
  entities: string[];
  amountTolerance: string;
  counts: { actions: number; verified: number; singleSource: number; structural: number; disagreements: number; oneSided: number; setAside: number };
  /** Two or more sources report the action on the same ex-date, with values outside tolerance. */
  disagreements: ReconcileFinding[];
  /** Exactly one source reports the action on this ex-date. */
  oneSided: ReconcileFinding[];
  /** Cash and split records on the entity and date of a curated structural action, not written. */
  setAside: SetAsideFinding[];
  /** Per entity, how many actions each source reported in the window: a source that is silent for an entity is visible here. */
  perEntity: { entityId: string; bySource: Record<string, number>; verified: number; singleSource: number }[];
};

export type ReconciledFile = {
  dataset: string;
  notes: string;
  approval: { approvedBy: null; approvedAt: null; actionsHash: string };
  actions: { action: Record<string, unknown>; announcedAt?: string; sources: string[] }[];
};

export class ReconcileInputError extends Error {
  constructor(detail: string) {
    super(`Corporate-action reconciliation input error: ${detail}`);
    this.name = "ReconcileInputError";
  }
}

const keyOf = (r: { entityId: string; kind: string; exDate: IsoDate }): string => `${r.entityId}|${r.kind}|${r.exDate}`;
const dayOf = (r: { entityId: string; exDate: IsoDate }): string => `${r.entityId}|${r.exDate}`;
const valueOf = (r: SourceAction): Dec => (r.kind === "CASH_DIVIDEND" ? r.amount : r.ratio);

function agrees(a: SourceAction, b: SourceAction, tolerance: Dec): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "CASH_DIVIDEND" ? valueOf(a).minus(valueOf(b)).abs().lte(tolerance) : valueOf(a).eq(valueOf(b));
}

/** The stored action for a record, validated by the same parser ingest and the read path use. */
function storedAction(r: SourceAction): Record<string, unknown> {
  const raw: Record<string, unknown> =
    r.kind === "CASH_DIVIDEND"
      ? // A source with no pay date gets the ex-date, as the Tiingo adapter does: the total-return series reads only
        // the ex-date and amount, and the repository requires payDate >= exDate. `qualified` is the tax-conservative
        // unknown; no source here states it.
        { kind: "CASH_DIVIDEND", entityId: r.entityId, amount: r.amount.toFixed(), exDate: r.exDate, payDate: r.payDate ?? r.exDate, qualified: false }
      : { kind: "SPLIT", entityId: r.entityId, ratio: r.ratio.toFixed(), exDate: r.exDate };
  // Rejects a non-positive amount or ratio and a pay date before the ex-date, among the rest.
  try {
    corporateActionFromValue(raw);
  } catch (err) {
    throw new ReconcileInputError(`${r.source} ${keyOf(r)}: ${err instanceof Error ? err.message : "malformed action"}`);
  }
  return raw;
}

type Entry = ReconciledFile["actions"][number];

/** Validate the curated structural entries; return the in-scope ones with their entity, kind and date. */
function structuralInScope(entries: readonly StructuralEntry[], entities: ReadonlySet<string>, window: { from: IsoDate; to: IsoDate }) {
  const out: { key: string; day: string; entityId: string; exDate: IsoDate; kind: string; entry: Entry }[] = [];
  const seen = new Set<string>();
  for (const [i, s] of entries.entries()) {
    let action;
    try {
      action = corporateActionFromValue(s.action);
    } catch (err) {
      throw new ReconcileInputError(`structural[${i}]: ${err instanceof Error ? err.message : "malformed action"}`);
    }
    if (!STRUCTURAL_KINDS.has(action.kind)) throw new ReconcileInputError(`structural[${i}] is ${action.kind}; only SPINOFF, MERGER and DELISTING are curated as structural`);
    const entityId = actionEntityId(action);
    const exDate = actionEffectiveDate(action);
    if (!entities.has(entityId) || exDate < window.from || exDate > window.to) continue;
    const key = keyOf({ entityId, kind: action.kind, exDate });
    if (seen.has(key)) throw new ReconcileInputError(`structural action ${key} is given twice`);
    seen.add(key);
    const entry: Entry = { action: s.action, sources: [...s.sources] };
    if (s.announcedAt !== undefined) entry.announcedAt = s.announcedAt;
    out.push({ key, day: dayOf({ entityId, exDate }), entityId, exDate, kind: action.kind, entry });
  }
  return out;
}

/**
 * Reconcile records from two or more sources into an unsigned vendored file and a report.
 *
 * Throws `ReconcileInputError` when the input itself is wrong - fewer than two sources, no record from any
 * preferred source, a source reporting the same entity, kind and ex-date twice (an adapter must sum a
 * distribution's components first), a record the action parser rejects, or a malformed or duplicated structural
 * entry - because guessing past any of those would put a fabricated number into evidence.
 */
export function reconcileCorporateActions(records: readonly SourceAction[], opts: ReconcileOptions): { file: ReconciledFile; report: ReconcileReport } {
  const entities = new Set(opts.entities);
  const sources = [...new Set(records.map((r) => r.source))].sort();
  if (sources.length < 2) throw new ReconcileInputError(`reconciliation needs at least two sources; got ${sources.length === 0 ? "none" : sources.join(", ")}`);
  if (opts.preferredSources.length === 0) throw new ReconcileInputError("name at least one preferred source");
  if (!opts.preferredSources.some((p) => sources.includes(p))) throw new ReconcileInputError(`none of the preferred sources (${opts.preferredSources.join(", ")}) supplied records`);

  const structural = structuralInScope(opts.structural ?? [], entities, opts.window);
  const structuralDays = new Map(structural.map((s) => [s.day, s]));

  const inWindow = records.filter((r) => entities.has(r.entityId) && r.exDate >= opts.window.from && r.exDate <= opts.window.to);
  const setAsideByDay = new Map<string, SetAsideFinding>();
  const inScope: SourceAction[] = [];
  for (const r of inWindow) {
    const s = structuralDays.get(dayOf(r));
    if (s === undefined) {
      inScope.push(r);
      continue;
    }
    const finding = setAsideByDay.get(s.day) ?? { entityId: s.entityId, exDate: s.exDate, structuralKind: s.kind, records: [] };
    finding.records.push({ source: r.source, kind: r.kind, value: valueOf(r).toFixed(), locator: r.locator });
    setAsideByDay.set(s.day, finding);
  }

  const groups = new Map<string, Map<string, SourceAction>>();
  for (const r of inScope) {
    const key = keyOf(r);
    const bySource = groups.get(key) ?? new Map<string, SourceAction>();
    if (bySource.has(r.source)) throw new ReconcileInputError(`${r.source} reports ${key} twice; sum a distribution's components into one record before reconciling`);
    bySource.set(r.source, r);
    groups.set(key, bySource);
  }

  const nearMatchDays = opts.nearMatchDays ?? 5;
  const nearMatchesFor = (r: SourceAction, missingFrom: readonly string[]): ReconcileFinding["nearMatches"] => {
    const lo = addDays(r.exDate, -nearMatchDays);
    const hi = addDays(r.exDate, nearMatchDays);
    return inScope
      .filter((o) => missingFrom.includes(o.source) && o.entityId === r.entityId && o.kind === r.kind && o.exDate !== r.exDate && o.exDate >= lo && o.exDate <= hi)
      .map((o) => ({ source: o.source, exDate: o.exDate, value: valueOf(o).toFixed() }))
      .sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : a.source < b.source ? -1 : 1));
  };

  const keyed: { key: string; entry: Entry }[] = structural.map((s) => ({ key: s.key, entry: s.entry }));
  const disagreements: ReconcileFinding[] = [];
  const oneSided: ReconcileFinding[] = [];
  for (const key of [...groups.keys()].sort()) {
    const bySource = groups.get(key);
    if (bySource === undefined) continue;
    const present = [...bySource.keys()].sort();
    // The first preferred source that reports the action carries the file's values; failing all of them, the
    // only information available is another source's, and it is written single-sourced.
    const preferred = opts.preferredSources.find((p) => bySource.has(p));
    const chosen = bySource.get(preferred ?? present[0] ?? "");
    if (chosen === undefined) continue;
    const agreeing = present.filter((s) => {
      const r = bySource.get(s);
      return r !== undefined && agrees(chosen, r, opts.amountTolerance);
    });
    const verified = agreeing.length >= 2;
    const entry: Entry = { action: storedAction(chosen), sources: verified ? agreeing : [chosen.source] };
    if (chosen.announcedAt !== undefined) entry.announcedAt = chosen.announcedAt;
    keyed.push({ key, entry });

    if (!verified || agreeing.length < present.length) {
      const finding: ReconcileFinding = {
        entityId: chosen.entityId,
        kind: chosen.kind,
        exDate: chosen.exDate,
        values: present.map((s) => {
          const r = bySource.get(s);
          return { source: s, value: r === undefined ? "" : valueOf(r).toFixed(), locator: r?.locator ?? "" };
        }),
        nearMatches: nearMatchesFor(chosen, sources.filter((s) => !present.includes(s))),
        written: { source: chosen.source, value: valueOf(chosen).toFixed() },
      };
      if (present.length >= 2) disagreements.push(finding);
      else oneSided.push(finding);
    }
  }

  // One order for the whole file, structural entries included, so the same inputs always hash the same.
  const entries = keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((k) => k.entry);
  const setAside = [...setAsideByDay.values()].sort((a, b) => (dayOf(a) < dayOf(b) ? -1 : dayOf(a) > dayOf(b) ? 1 : 0));
  for (const f of setAside) f.records.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.kind < b.kind ? -1 : 1));

  const isVerified = (e: Entry): boolean => new Set(e.sources).size >= 2;
  const actionsHash = corporateActionsHash(entries);
  const verifiedCount = entries.filter(isVerified).length;
  const perEntity = [...entities].sort().map((entityId) => {
    const bySource: Record<string, number> = {};
    for (const s of sources) bySource[s] = inScope.filter((r) => r.entityId === entityId && r.source === s).length;
    const mine = entries.filter((e) => actionEntityId(corporateActionFromValue(e.action)) === entityId);
    return { entityId, bySource, verified: mine.filter(isVerified).length, singleSource: mine.filter((e) => !isVerified(e)).length };
  });

  const report: ReconcileReport = {
    reconcileVersion: RECONCILE_VERSION,
    dataset: opts.dataset,
    sources,
    preferredSources: [...opts.preferredSources],
    window: opts.window,
    entities: [...entities].sort(),
    amountTolerance: opts.amountTolerance.toFixed(),
    counts: {
      actions: entries.length,
      verified: verifiedCount,
      singleSource: entries.length - verifiedCount,
      structural: structural.length,
      disagreements: disagreements.length,
      oneSided: oneSided.length,
      setAside: setAside.reduce((n, f) => n + f.records.length, 0),
    },
    disagreements,
    oneSided,
    setAside,
    perEntity,
  };

  const file: ReconciledFile = {
    dataset: opts.dataset,
    notes: `Machine-reconciled (reconcile v${RECONCILE_VERSION}) from ${sources.join(", ")} over ex-dates ${opts.window.from}..${opts.window.to}, cash tolerance ${opts.amountTolerance.toFixed()} per share, preferred sources ${opts.preferredSources.join(" > ")}, with ${structural.length} owner-curated structural action(s). ${verifiedCount} of ${entries.length} actions are confirmed by two or more sources; the rest carry one source and are flagged UNVERIFIED_SINGLE_SOURCE on ingest. UNSIGNED: ingest refuses this file until the owner audits it against its report and fills approval.approvedBy and approval.approvedAt (D-57).`,
    approval: { approvedBy: null, approvedAt: null, actionsHash },
    actions: entries,
  };
  return { file, report };
}

/**
 * Corporate-action observations (any adapter's) as reconciliation records for `source`. Only CASH_DIVIDEND and
 * SPLIT are carried; the rest are structural and curated by the owner.
 */
export function sourceActionsFromObservations(observations: readonly PointInTimeObservation<Record<string, unknown>>[], source: string): SourceAction[] {
  const out: SourceAction[] = [];
  for (const o of observations) {
    const a = corporateActionFromValue(o.value);
    const base = { source, entityId: "", exDate: "" as IsoDate, locator: o.sourceLocator };
    if (a.kind === "CASH_DIVIDEND") out.push({ ...base, kind: "CASH_DIVIDEND", entityId: a.entityId, exDate: a.exDate, amount: a.amount, payDate: a.payDate });
    else if (a.kind === "SPLIT") out.push({ ...base, kind: "SPLIT", entityId: a.entityId, exDate: a.exDate, ratio: a.ratio });
  }
  return out;
}
