import { addDays, Dec, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { actionEffectiveDate, actionEntityId, corporateActionFromValue, seriesLastDate, unreadActionKeys, unvaluedActionReason } from "../market/types.ts";
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
 * spans it. So every action in the windows goes into the file. One that at least two sources agree on names them
 * all in `sources`; one that they do not is written with the single source whose value it carries, which ingest
 * flags `UNVERIFIED_SINGLE_SOURCE` - so any run touching it stays uncitable - and it is listed in the report for
 * the owner to resolve. Reconciliation can make the evidence citable; it can never make it look better than it is.
 *
 * Pure: records in, file and report out. CASH_DIVIDEND and SPLIT are reconciled. Structural actions (SPINOFF,
 * MERGER, DELISTING) are a handful of cases the owner curates with their own sources (D-58), and they pass through
 * as written. A cash or split record on the same entity and date is ambiguous: it may be the structural action
 * itself in another source's columns (SSGA's XLF row of 2016-09-19 is the XLRE share ratio in its dollar column),
 * which writing would count twice, or a genuine action of its own, which dropping would lose. Neither default is
 * safe, so the curator classifies each one: `supersedes` sets it aside, reported but not written; `keeps` reconciles
 * it as usual. An unclassified one refuses the run. Setting aside is the one place a record does not reach the
 * file, and only ever on the owner's word.
 *
 * A MERGER or DELISTING ends its entity's total-return series, which ignores anything dated after its last bar. So
 * it also classifies every record dated after that - naming each by `exDate`, a merger's own date included - and
 * may only supersede them: a distribution paid with a merger or on delisting belongs in the terminal value
 * (`terms.cashPerShare`, `finalPrice`), and a kept one, or a spin-off, past the end would be written, verified, and
 * never applied. One outside the windows is not written, so a record after it inside them refuses the run.
 */
/**
 * 2 added structural pass-through and issuer sources (D-58); 3 classifies records past a series end; 4 names them
 * by date and counts a terminal action outside the window; 5 reconciles over several windows. Every change to the
 * output bumps this.
 */
export const RECONCILE_VERSION = 5;

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

/**
 * A record a structural action classifies, by source and kind (each source has at most one per entity, kind and
 * date). With no `exDate` it is the one on the action's own date; a MERGER or DELISTING may also name, by `exDate`,
 * one dated after the series end it sets.
 */
export type RecordSelector = { source: string; kind: SourceAction["kind"]; exDate?: IsoDate | undefined };

/**
 * An owner-curated structural action (D-58). `action`, `sources` and `announcedAt` are written as given, in the
 * vendored file's entry shape. `supersedes` and `keeps` classify the same-day records and are not written.
 */
export type StructuralEntry = {
  action: Record<string, unknown>;
  sources: string[];
  announcedAt?: string | undefined;
  /** Records this action replaces, such as a spin-off listed in a dividend column or a merger's final payout: set aside. */
  supersedes?: readonly RecordSelector[] | undefined;
  /** Same-day records that are separate, genuine actions: reconciled as usual. Never past a series end. */
  keeps?: readonly RecordSelector[] | undefined;
};

const STRUCTURAL_KINDS = new Set(["SPINOFF", "MERGER", "DELISTING"]);

export type ReconcileOptions = {
  dataset: string;
  /**
   * Inclusive ex-date windows - for a charter, each evaluated window with its feature warm-up in front. Records in
   * none of them are ignored on every side, so a longer history is not "one-sided", and the sealed stretch between
   * windows that no decision reads is left out rather than reported as missing.
   */
  windows: readonly { from: IsoDate; to: IsoDate }[];
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
  /** Owner-curated structural actions, written as given, each classifying its same-day records (and, if terminal, later ones). */
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

type ListedRecord = { source: string; kind: SourceAction["kind"]; exDate: IsoDate; value: string; locator: string };

export type SetAsideFinding = {
  entityId: string;
  exDate: IsoDate;
  /** The structural action(s) on this entity and date. */
  structuralKind: string;
  /** Records the owner said the structural action supersedes, on its date or past a series end it sets: not written. */
  records: ListedRecord[];
  /** Records the owner said are separate actions: reconciled as usual, listed here so the audit sees the date. */
  kept: ListedRecord[];
};

export type ReconcileReport = {
  reconcileVersion: number;
  dataset: string;
  sources: string[];
  preferredSources: string[];
  windows: { from: IsoDate; to: IsoDate }[];
  entities: string[];
  amountTolerance: string;
  counts: { actions: number; verified: number; singleSource: number; structural: number; disagreements: number; oneSided: number; setAside: number };
  /** Two or more sources report the action on the same ex-date, with values outside tolerance. */
  disagreements: ReconcileFinding[];
  /** Exactly one source reports the action on this ex-date. */
  oneSided: ReconcileFinding[];
  /** Every entity and date with a curated structural action, and what happened to the records on it. */
  setAside: SetAsideFinding[];
  /** Curated structural actions not written because they fall outside the entities or the windows: listed, never silent. */
  structuralOutOfScope: { index: number; kind: string; entityId: string; exDate: IsoDate; reason: string }[];
  /** Per entity, how many actions each source reported in the windows: a source that is silent for an entity is visible here. */
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

/** One record, by entity, source, kind and date: what a structural action's `supersedes` and `keeps` name. */
const recordId = (entityId: string, source: string, kind: string, exDate: IsoDate): string => `${entityId}|${source}|${kind}|${exDate}`;
const shownId = (id: string): string => id.split("|").slice(1).join(" ");

type SeriesEnd = { label: string; lastDate: IsoDate };

const inAny = (windows: ReconcileOptions["windows"], d: IsoDate): boolean => windows.some((w) => d >= w.from && d <= w.to);

/** Validate the curated structural entries; return the in-scope ones with their entity, kind and date. */
function structuralInScope(entries: readonly StructuralEntry[], entities: ReadonlySet<string>, windows: ReconcileOptions["windows"]) {
  const out: { key: string; day: string; entityId: string; exDate: IsoDate; kind: string; entry: Entry; supersedes: Set<string>; keeps: Set<string> }[] = [];
  const seen = new Set<string>();
  // The series ends an entity at its first MERGER or DELISTING and ignores any other, so at most one may be given -
  // written or not: one outside the windows still ends the series inside them.
  const ends = new Map<string, SeriesEnd & { written: boolean }>();
  const outOfScope: ReconcileReport["structuralOutOfScope"] = [];
  for (const [i, s] of entries.entries()) {
    let action;
    try {
      action = corporateActionFromValue(s.action);
    } catch (err) {
      throw new ReconcileInputError(`structural[${i}]: ${err instanceof Error ? err.message : "malformed action"}`);
    }
    if (!STRUCTURAL_KINDS.has(action.kind)) throw new ReconcileInputError(`structural[${i}] is ${action.kind}; only SPINOFF, MERGER and DELISTING are curated as structural`);
    // Written as given, so every key must be one the read path reads: a misspelled childFirstClose would otherwise
    // be signed, ingested, and silently left out of the parent's total return.
    const unread = unreadActionKeys(s.action, action);
    if (unread.length > 0) throw new ReconcileInputError(`structural[${i}]: a ${action.kind} has no field ${unread.join(", ")}`);
    // Ingest refuses it too; refusing here names the problem before the owner audits and signs a file it can't load.
    const unvalued = unvaluedActionReason(action);
    if (unvalued !== undefined) throw new ReconcileInputError(`structural[${i}]: ${unvalued}`);
    const entityId = actionEntityId(action);
    const exDate = actionEffectiveDate(action);
    if (!entities.has(entityId)) {
      // "xlf" for XLF is a typo, not another entity: refusing it beats silently dropping the action.
      const meant = [...entities].find((e) => e.toUpperCase() === entityId.toUpperCase());
      if (meant !== undefined) throw new ReconcileInputError(`structural[${i}] names ${entityId}; the entity is ${meant}`);
      outOfScope.push({ index: i, kind: action.kind, entityId, exDate, reason: "entity not in scope" });
      continue;
    }
    const inWindow = inAny(windows, exDate);
    const lastDate = action.kind === "MERGER" || action.kind === "DELISTING" ? seriesLastDate(action) : undefined;
    if (lastDate !== undefined) {
      const earlier = ends.get(entityId);
      if (earlier !== undefined) throw new ReconcileInputError(`${entityId} has two terminal actions, ${earlier.label} and ${action.kind} ${exDate}; the series would apply only one`);
      ends.set(entityId, { label: `${action.kind} ${exDate}`, lastDate, written: inWindow });
    }
    if (!inWindow) {
      outOfScope.push({ index: i, kind: action.kind, entityId, exDate, reason: "outside the windows" });
      continue;
    }
    const key = keyOf({ entityId, kind: action.kind, exDate });
    if (seen.has(key)) throw new ReconcileInputError(`structural action ${key} is given twice`);
    seen.add(key);
    // A selector with no exDate names the record on the action's own date. Only a terminal action may name another
    // date, and only one past its series end - so no action's list can reach a record that is another's to classify.
    const named = (list: readonly RecordSelector[] | undefined, which: string): { id: string; date: IsoDate }[] =>
      (list ?? []).map((r) => {
        const date = r.exDate ?? exDate;
        if (date !== exDate && (lastDate === undefined || date <= lastDate)) {
          throw new ReconcileInputError(
            `structural[${i}] ${which} ${r.source} ${r.kind} on ${date}: an action classifies records on its own date; only a MERGER or DELISTING names a later one, after its series ends`,
          );
        }
        return { id: recordId(entityId, r.source, r.kind, date), date };
      });
    const supersedes = new Set(named(s.supersedes, "supersedes").map((n) => n.id));
    const kept = named(s.keeps, "keeps");
    const keeps = new Set(kept.map((n) => n.id));
    const both = [...supersedes].filter((id) => keeps.has(id));
    if (both.length > 0) throw new ReconcileInputError(`structural[${i}] both supersedes and keeps ${both.map(shownId).join(", ")}`);
    // The series ignores anything after its end - a merger's own date included - so nothing there can be kept.
    const late = lastDate === undefined ? [] : kept.filter((n) => n.date > lastDate);
    if (late.length > 0) {
      throw new ReconcileInputError(
        `structural[${i}] keeps ${late.map((n) => shownId(n.id)).join(", ")}, after the series its ${action.kind} ends, which would ignore it: fold a payout into terms.cashPerShare or finalPrice and list the record under supersedes`,
      );
    }
    const entry: Entry = { action: s.action, sources: [...s.sources] };
    if (s.announcedAt !== undefined) entry.announcedAt = s.announcedAt;
    out.push({ key, day: dayOf({ entityId, exDate }), entityId, exDate, kind: action.kind, entry, supersedes, keeps });
  }
  // A spin-off after its parent's series ends would be written and never credited.
  for (const s of out) {
    const end = ends.get(s.entityId);
    if (s.kind === "SPINOFF" && end !== undefined && s.exDate > end.lastDate) {
      throw new ReconcileInputError(`the ${s.entityId} SPINOFF ${s.exDate} falls after ${s.entityId}'s series ends with its ${end.label}, so its value would never be credited`);
    }
  }
  return { inScope: out, outOfScope, ends };
}

/**
 * Reconcile records from two or more sources into an unsigned vendored file and a report.
 *
 * Throws `ReconcileInputError` when the input itself is wrong - fewer than two sources, no record from any
 * preferred source, a source reporting the same entity, kind and ex-date twice (an adapter must sum a
 * distribution's components first), a record the action parser rejects, a malformed or duplicated structural
 * entry, a record or spin-off past the series end a merger or delisting sets that the curator has not superseded -
 * because guessing past any of those would put a fabricated number into evidence.
 */
export function reconcileCorporateActions(records: readonly SourceAction[], opts: ReconcileOptions): { file: ReconciledFile; report: ReconcileReport } {
  const entities = new Set(opts.entities);
  const sources = [...new Set(records.map((r) => r.source))].sort();
  if (sources.length < 2) throw new ReconcileInputError(`reconciliation needs at least two sources; got ${sources.length === 0 ? "none" : sources.join(", ")}`);
  if (opts.preferredSources.length === 0) throw new ReconcileInputError("name at least one preferred source");
  if (!opts.preferredSources.some((p) => sources.includes(p))) throw new ReconcileInputError(`none of the preferred sources (${opts.preferredSources.join(", ")}) supplied records`);

  if (opts.windows.length === 0) throw new ReconcileInputError("name at least one ex-date window");
  for (const w of opts.windows) if (w.to < w.from) throw new ReconcileInputError(`window ${w.from}..${w.to} ends before it starts`);
  const { inScope: structural, outOfScope: structuralOutOfScope, ends } = structuralInScope(opts.structural ?? [], entities, opts.windows);
  // Which action, by its day, set aside or kept each record it names. Names are dated, so lists never overlap by accident.
  const supersededBy = new Map<string, string>();
  const keptBy = new Map<string, string>();
  const structuralDays = new Map<string, { kinds: string[]; entityId: string; exDate: IsoDate }>();
  for (const s of structural) {
    const d = structuralDays.get(s.day) ?? { kinds: [], entityId: s.entityId, exDate: s.exDate };
    d.kinds.push(s.kind);
    structuralDays.set(s.day, d);
    for (const id of s.supersedes) supersededBy.set(id, s.day);
    for (const id of s.keeps) keptBy.set(id, s.day);
  }
  // Each entry is checked alone above; two can still contradict each other.
  const contradicted = [...supersededBy.keys()].filter((id) => keptBy.has(id));
  if (contradicted.length > 0) {
    const day = supersededBy.get(contradicted[0] ?? "") ?? "";
    throw new ReconcileInputError(`the structural actions on ${day.replace("|", " ")} disagree: one supersedes and another keeps ${contradicted.map(shownId).join(", ")}`);
  }

  const inWindow = records.filter((r) => entities.has(r.entityId) && inAny(opts.windows, r.exDate));
  // Before anything is classified, so a duplicate is refused even where it would be set aside.
  const seenRecords = new Set<string>();
  for (const r of inWindow) {
    const id = `${r.source}|${keyOf(r)}`;
    if (seenRecords.has(id)) throw new ReconcileInputError(`${r.source} reports ${keyOf(r)} twice; sum a distribution's components into one record before reconciling`);
    seenRecords.add(id);
  }
  // A terminal action outside the windows is not written, so nothing can classify a record after it: refuse.
  const beyondUnwritten = inWindow.filter((r) => {
    const end = ends.get(r.entityId);
    return end !== undefined && !end.written && r.exDate > end.lastDate;
  });
  if (beyondUnwritten.length > 0) {
    throw new ReconcileInputError(
      `the series ignores anything after a merger's target stops trading or a delisted entity's last trade, and these fall after one outside the windows: ${beyondUnwritten.map((r) => `${r.entityId} ${r.exDate}: ${r.source} ${r.kind} ${valueOf(r).toFixed()} (after its ${ends.get(r.entityId)?.label ?? ""})`).join("; ")}`,
    );
  }
  const setAsideByDay = new Map<string, SetAsideFinding>();
  for (const [day, d] of structuralDays) setAsideByDay.set(day, { entityId: d.entityId, exDate: d.exDate, structuralKind: d.kinds.sort().join("+"), records: [], kept: [] });
  const findingFor = (day: string): SetAsideFinding => {
    const f = setAsideByDay.get(day);
    if (f === undefined) throw new Error(`no structural finding for ${day}`);
    return f;
  };
  const inScope: SourceAction[] = [];
  const unclassified: string[] = [];
  for (const r of inWindow) {
    // A record on a structural action's date, or past its entity's series end, must be named by the curator.
    const end = ends.get(r.entityId);
    const pastEnd = end !== undefined && r.exDate > end.lastDate;
    if (!pastEnd && !structuralDays.has(dayOf(r))) {
      inScope.push(r);
      continue;
    }
    const id = recordId(r.entityId, r.source, r.kind, r.exDate);
    const listed = { source: r.source, kind: r.kind, exDate: r.exDate, value: valueOf(r).toFixed(), locator: r.locator };
    const supersededOn = supersededBy.get(id);
    const keptOn = keptBy.get(id);
    if (supersededOn !== undefined) findingFor(supersededOn).records.push(listed);
    else if (keptOn !== undefined) {
      findingFor(keptOn).kept.push(listed);
      inScope.push(r);
    } else unclassified.push(`${r.entityId} ${r.exDate}: ${r.source} ${r.kind} ${valueOf(r).toFixed()}${pastEnd ? ` (after its ${end.label})` : ""}`);
  }
  if (unclassified.length > 0) {
    throw new ReconcileInputError(
      `each record on the date of a curated structural action must be listed under its supersedes (the structural action replaces it) or keeps (a separate, genuine action), and each after a merger or delisting ends its entity's series under that action's supersedes, by exDate: ${unclassified.join("; ")}`,
    );
  }

  const groups = new Map<string, Map<string, SourceAction>>();
  for (const r of inScope) {
    const key = keyOf(r);
    const bySource = groups.get(key) ?? new Map<string, SourceAction>();
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
  const bySourceKind = (a: ListedRecord, b: ListedRecord): number =>
    a.exDate !== b.exDate ? (a.exDate < b.exDate ? -1 : 1) : a.source < b.source ? -1 : a.source > b.source ? 1 : a.kind < b.kind ? -1 : 1;
  for (const f of setAside) {
    f.records.sort(bySourceKind);
    f.kept.sort(bySourceKind);
  }

  // The report names every publisher behind the file, structural ones included, and counts them per entity.
  const reportSources = [...new Set([...sources, ...structural.flatMap((s) => s.entry.sources)])].sort();
  const isVerified = (e: Entry): boolean => new Set(e.sources).size >= 2;
  const actionsHash = corporateActionsHash(entries);
  const verifiedCount = entries.filter(isVerified).length;
  const perEntity = [...entities].sort().map((entityId) => {
    const bySource: Record<string, number> = {};
    for (const s of reportSources) {
      // Every record a source reported in the windows, set-aside ones included: the audit compares these with setAside.
      bySource[s] = inWindow.filter((r) => r.entityId === entityId && r.source === s).length + structural.filter((x) => x.entityId === entityId && x.entry.sources.includes(s)).length;
    }
    const mine = entries.filter((e) => actionEntityId(corporateActionFromValue(e.action)) === entityId);
    return { entityId, bySource, verified: mine.filter(isVerified).length, singleSource: mine.filter((e) => !isVerified(e)).length };
  });

  const report: ReconcileReport = {
    reconcileVersion: RECONCILE_VERSION,
    dataset: opts.dataset,
    sources: reportSources,
    preferredSources: [...opts.preferredSources],
    windows: opts.windows.map((w) => ({ from: w.from, to: w.to })),
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
    structuralOutOfScope,
    perEntity,
  };

  const file: ReconciledFile = {
    dataset: opts.dataset,
    notes: `Machine-reconciled (reconcile v${RECONCILE_VERSION}) from ${reportSources.join(", ")} over ex-dates ${opts.windows.map((w) => `${w.from}..${w.to}`).join(" and ")}, cash tolerance ${opts.amountTolerance.toFixed()} per share, preferred sources ${opts.preferredSources.join(" > ")}, with ${structural.length} owner-curated structural action(s). ${verifiedCount} of ${entries.length} actions are confirmed by two or more sources; the rest carry one source and are flagged UNVERIFIED_SINGLE_SOURCE on ingest. UNSIGNED: ingest refuses this file until the owner audits it against its report and fills approval.approvedBy and approval.approvedAt (D-57).`,
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
