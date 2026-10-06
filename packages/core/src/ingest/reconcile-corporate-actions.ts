import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { Dec, nowUtc, type IsoDate, type UtcInstant } from "@blackgold/shared";
import { processingDelayOverridesMs } from "../config/schema.ts";
import { ArtifactStore } from "../data/artifacts/store.ts";
import { fetchAndStore } from "../data/adapters/common.ts";
import { ISHARES_DISTRIBUTIONS_SOURCE, parseIsharesDistributions } from "../data/adapters/ishares-distributions.ts";
import { parseSsgaDistributions, SSGA_DISTRIBUTIONS_SOURCE, SSGA_NAV_HISTORY_SOURCE, ssgaNavSplits, type NavJump } from "../data/adapters/ssga-distributions.ts";
import { parseVanguardDistributions, VANGUARD_DISTRIBUTIONS_SOURCE } from "../data/adapters/vanguard-distributions.ts";
import { DEFAULT_AMOUNT_TOLERANCE, reconcileCorporateActions, sourceActionsFromObservations, type ReconcileReport, type SourceAction, type StructuralEntry } from "../data/corporate-actions-reconcile.ts";
import { parseCuratedActions, parseCuratedStructural } from "../data/curated-corporate-actions.ts";
import { PointInTimeRepository } from "../data/pit/repository.ts";
import type { PointInTimeObservation } from "../data/pit/types.ts";
import { Ledger } from "../ledger/ledger.ts";
import { corporateActionSourceId, dateStartUtc } from "../market/types.ts";
import { charterRange, charterUniverseMembers, loadCharterFile } from "../strategy/charter.ts";
import { featureLoadStart, featureParamsFromCharter } from "../strategy/features.ts";
import { buildPublicSourceClient, parseOptions, UsageError, type IngestDeps } from "./run.ts";

/**
 * `reconcile corporate-actions` (D-57, D-58): build the unsigned ≥2-source vendored file for a charter, and the
 * report the owner audits it against before signing.
 *
 * - **Scope comes from the charter**: its universe, cash and benchmarks, over each evaluated window (DESIGN and
 *   RECENT, never the holdout) with the feature warm-up `computeFeatures` reads in front of it.
 * - **Tiingo's records are read from this store** - the research store, where `ingest tiingo-actions` ran - and
 *   never written anywhere: the citable evaluation runs from a separate store that holds no Tiingo action rows
 *   (D-57(b)), and this command appends no observation to any store.
 * - **State Street is fetched** through the allowlisted client: the all-funds distribution workbook, then the NAV
 *   history of every in-scope fund it lists (for splits).
 * - **Everything else is a file the owner supplies**: Vanguard and iShares downloads (never fetched; D-58), the
 *   curated CSV, and the structural actions.
 *
 * Every input's raw bytes are stored as an artifact, so the file can be rebuilt from exactly what it was built
 * from. The output and the report are created, never overwritten - a signed file must not be clobbered by a re-run
 * - and one ledger event records the run.
 */

export const VENDOR_SOURCE = "vendor:tiingo-eod";
const TIINGO_LOCATOR_PREFIX = "tiingo/corporate-actions/";

export const SSGA_DISTRIBUTIONS_URL = "https://www.ssga.com/library-content/products/fund-data/etfs/us/spdr-etf-historical-distributions.xlsx";
export function ssgaNavHistoryUrl(etf: string): string {
  return `https://www.ssga.com/library-content/products/fund-data/etfs/us/navhist-us-en-${etf.trim().toLowerCase()}.xlsx`;
}
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The fund names iShares workbooks carry, by ticker: a downloaded workbook must name the fund it is passed for. */
export const ISHARES_FUND_NAMES: Readonly<Record<string, string>> = { IWM: "iShares Russell 2000 ETF" };

export type ReconcileRequest = {
  charter: string;
  out: string;
  report: string;
  vanguard: { entityId: string; file: string }[];
  ishares: { entityId: string; file: string }[];
  curated?: string | undefined;
  structural?: string | undefined;
  dataset?: string | undefined;
};

export const RECONCILE_USAGE = `reconcile corporate-actions --charter <charter.yaml> --out <file.json> --report <report.json>
    [--vanguard VTI=<file.json>,VTV=<file.json>,...] [--ishares IWM=<file.xls>] [--curated <rows.csv>] [--structural <actions.json>] [--dataset <name>]`;

function pairs(v: string | boolean | undefined, flag: string): { entityId: string; file: string }[] {
  if (typeof v !== "string" || v.trim() === "") return [];
  return v.split(",").map((part) => {
    const at = part.indexOf("=");
    const entityId = part.slice(0, at).trim().toUpperCase();
    const file = part.slice(at + 1).trim();
    if (at <= 0 || entityId === "" || file === "") throw new UsageError(`--${flag} takes TICKER=<file> pairs, comma-separated; got "${part}"`);
    return { entityId, file };
  });
}

export function parseReconcileArgs(args: readonly string[]): ReconcileRequest {
  const [what, ...rest] = args;
  if (what !== "corporate-actions") throw new UsageError(`reconcile requires the subcommand corporate-actions\n${RECONCILE_USAGE}`);
  const o = parseOptions(rest, {
    charter: { type: "string" },
    out: { type: "string" },
    report: { type: "string" },
    vanguard: { type: "string" },
    ishares: { type: "string" },
    curated: { type: "string" },
    structural: { type: "string" },
    dataset: { type: "string" },
  });
  const need = (k: string): string => {
    const v = o[k];
    if (typeof v !== "string" || v.trim() === "") throw new UsageError(`reconcile corporate-actions requires --${k}\n${RECONCILE_USAGE}`);
    return v.trim();
  };
  const opt = (k: string): string | undefined => (typeof o[k] === "string" && o[k].trim() !== "" ? o[k].trim() : undefined);
  return { charter: need("charter"), out: need("out"), report: need("report"), vanguard: pairs(o["vanguard"], "vanguard"), ishares: pairs(o["ishares"], "ishares"), curated: opt("curated"), structural: opt("structural"), dataset: opt("dataset") };
}

export type ReconcileSummary = {
  out: string;
  report: string;
  dataset: string;
  charterHash: string;
  actionsHash: string;
  counts: ReconcileReport["counts"];
  /** Actions only the vendor reports: each needs a curated row (or an issuer file) before it can be verified. */
  toCurate: number;
  artifacts: string[];
  ledgerSeq: number;
};

type Stored = { hash: string; locator: string };

/** Tiingo's corporate-action rows in this store, newest parse per action, and any action whose value was revised. */
function vendorRecords(repo: PointInTimeRepository, entities: ReadonlySet<string>) {
  const newest = new Map<string, PointInTimeObservation<Record<string, unknown>>>();
  const values = new Map<string, Set<string>>();
  for (const kind of ["CASH_DIVIDEND", "SPLIT"] as const) {
    for (const row of repo.all<Record<string, unknown>>(corporateActionSourceId(kind))) {
      if (!row.sourceLocator.startsWith(TIINGO_LOCATOR_PREFIX) || row.entityId === undefined || !entities.has(row.entityId)) continue;
      newest.set(row.sourceLocator, row); // rows come back in id order, so the last one is the newest
      const seen = values.get(row.sourceLocator) ?? new Set<string>();
      seen.add(JSON.stringify(row.value));
      values.set(row.sourceLocator, seen);
    }
  }
  const revised = [...values.entries()].filter(([, v]) => v.size > 1).map(([locator]) => locator).sort();
  return { records: sourceActionsFromObservations([...newest.values()], VENDOR_SOURCE), revised };
}

export async function runReconcile(deps: IngestDeps, request: ReconcileRequest): Promise<ReconcileSummary> {
  const clock = deps.clock ?? Date.now;
  const startedAt: UtcInstant = nowUtc(clock);
  for (const path of [request.out, request.report]) {
    if (existsSync(path)) throw new UsageError(`${path} already exists; reconcile never overwrites an output (a signed file could be lost). Choose a new path.`);
  }

  // Scope: the charter's universe and benchmarks, over each evaluated window with its feature warm-up.
  const loaded = loadCharterFile(request.charter);
  const c = loaded.charter;
  const entities = [...new Set([...charterUniverseMembers(c), c.benchmarks.primary, c.benchmarks.cash, ...c.benchmarks.secondary])].sort();
  const inScope = new Set(entities);
  const params = featureParamsFromCharter(c);
  const windows = (["design", "recent"] as const).map((seg) => {
    const r = charterRange(c, seg);
    // A decision before the close of the window's first day is computed on the session before it, so the warm-up
    // is counted from that session: the earliest one any decision in the window reads from.
    const earliestDecisionSession = deps.calendar.previousSession(dateStartUtc(r.start));
    return { segment: seg, from: featureLoadStart(earliestDecisionSession, params), to: r.end, evaluatedFrom: r.start };
  });
  const dataset = request.dataset ?? `${c.strategy_id}-reconciled`;

  const store = new ArtifactStore(deps.config.artifactsDir, deps.db, clock, { budgetBytes: deps.config.sources.artifactBudgetBytes });
  const artifacts: string[] = [];
  const keep = (bytes: Uint8Array, locator: string, mime: string): Stored => {
    const put = store.put(bytes, { locator, mime, retention: "market" });
    artifacts.push(put.hash);
    return { hash: put.hash, locator };
  };
  const readFile = (path: string, what: string): Uint8Array => {
    try {
      return new Uint8Array(readFileSync(path));
    } catch (err) {
      throw new UsageError(`cannot read the ${what} file ${path}: ${err instanceof Error ? err.message : "read error"}`);
    }
  };
  const inScopeOrRefuse = (entityId: string, flag: string): void => {
    if (!inScope.has(entityId)) throw new UsageError(`--${flag} names ${entityId}, which is not in the charter's scope (${entities.join(", ")})`);
  };

  // Owner files first: a bad file fails before any network request.
  const records: SourceAction[] = [];
  const owner: { vanguardZeroDates: Record<string, IsoDate[]>; isharesZeroDates: Record<string, IsoDate[]> } = { vanguardZeroDates: {}, isharesZeroDates: {} };
  for (const { entityId, file } of request.vanguard) {
    inScopeOrRefuse(entityId, "vanguard");
    const bytes = readFile(file, `Vanguard ${entityId}`);
    const a = keep(bytes, `owner/vanguard/${entityId}/${basename(file)}`, "application/json");
    const v = parseVanguardDistributions(bytes, { entityId, locator: a.hash });
    records.push(...v.records);
    owner.vanguardZeroDates[entityId] = v.zeroDates;
  }
  for (const { entityId, file } of request.ishares) {
    inScopeOrRefuse(entityId, "ishares");
    const fundName = ISHARES_FUND_NAMES[entityId];
    if (fundName === undefined) throw new UsageError(`--ishares: no known iShares fund name for ${entityId} (known: ${Object.keys(ISHARES_FUND_NAMES).join(", ")})`);
    const bytes = readFile(file, `iShares ${entityId}`);
    const a = keep(bytes, `owner/ishares/${entityId}/${basename(file)}`, "application/vnd.ms-excel");
    const i = parseIsharesDistributions(bytes, { entityId, fundName, locator: a.hash });
    records.push(...i.records);
    owner.isharesZeroDates[entityId] = i.zeroDates;
  }
  const curatedSources: string[] = [];
  if (request.curated !== undefined) {
    const bytes = readFile(request.curated, "curated");
    keep(bytes, `owner/curated/${basename(request.curated)}`, "text/csv");
    const rows = parseCuratedActions(bytes, { file: basename(request.curated) });
    for (const r of rows) if (!curatedSources.includes(r.source)) curatedSources.push(r.source);
    records.push(...rows);
  }
  let structural: StructuralEntry[] = [];
  if (request.structural !== undefined) {
    const bytes = readFile(request.structural, "structural");
    keep(bytes, `owner/structural/${basename(request.structural)}`, "application/json");
    structural = parseCuratedStructural(bytes, { file: basename(request.structural) });
  }

  // The vendor: read from this store, written nowhere.
  const repo = new PointInTimeRepository(deps.db, { clock, processingDelayOverrides: processingDelayOverridesMs(deps.config.sources) });
  const vendor = vendorRecords(repo, inScope);
  if (vendor.records.length === 0) {
    throw new UsageError(`this store holds no Tiingo corporate actions for ${entities.join(", ")}. Run reconcile against the research store, where ingest tiingo-actions has run - never against the evaluation store (D-57(b)).`);
  }
  records.push(...vendor.records);

  // State Street: the all-funds workbook, then NAV history for every in-scope fund it lists.
  const client = buildPublicSourceClient(deps.config, deps.fetchImpl);
  const dist = await fetchAndStore(client, store, SSGA_DISTRIBUTIONS_URL, { locator: SSGA_DISTRIBUTIONS_URL, mime: XLSX_MIME, retention: "market" });
  artifacts.push(dist.put.hash);
  const ssga = await parseSsgaDistributions(dist.response.body, { entities, locator: dist.put.hash });
  records.push(...ssga.records);
  const ssgaFunds = [...new Set([...ssga.records.map((r) => r.entityId), ...ssga.zeroRows.map((z) => z.entityId)])].sort();
  const nav: Record<string, { splits: number; jumps: NavJump[]; gaps: number; firstDate: IsoDate; sharesFirstDate: IsoDate | undefined }> = {};
  for (const etf of ssgaFunds) {
    const url = ssgaNavHistoryUrl(etf);
    const got = await fetchAndStore(client, store, url, { locator: url, mime: XLSX_MIME, retention: "market" });
    artifacts.push(got.put.hash);
    const n = await ssgaNavSplits(got.response.body, { etf, locator: got.put.hash, calendar: deps.calendar });
    records.push(...n.records);
    nav[etf] = { splits: n.records.length, jumps: n.jumps, gaps: n.gaps.length, firstDate: n.firstDate, sharesFirstDate: n.sharesFirstDate };
  }

  const { file, report } = reconcileCorporateActions(records, {
    dataset,
    windows: windows.map((w) => ({ from: w.from, to: w.to })),
    entities,
    preferredSources: [SSGA_DISTRIBUTIONS_SOURCE, SSGA_NAV_HISTORY_SOURCE, VANGUARD_DISTRIBUTIONS_SOURCE, ISHARES_DISTRIBUTIONS_SOURCE, ...curatedSources.sort()],
    amountTolerance: new Dec(DEFAULT_AMOUNT_TOLERANCE),
    structural,
  });

  // What the owner still has to curate: every action only the vendor reports, by fund and ex-date.
  const toCurate = report.oneSided.filter((f) => f.written.source === VENDOR_SOURCE).map((f) => ({ entityId: f.entityId, kind: f.kind, exDate: f.exDate, vendorValue: f.written.value }));
  const fullReport = {
    reconcileVersion: report.reconcileVersion,
    charter: { path: request.charter, charterHash: loaded.charterHash, strategyId: c.strategy_id, charterVersion: c.charter_version },
    windows,
    startedAt,
    toCurate,
    issuer: {
      ssgaFunds,
      ssgaZeroRows: ssga.zeroRows.length,
      ssgaPayDateDropped: ssga.payDateDropped,
      ssgaNavHistory: nav,
      ...owner,
    },
    vendor: { source: VENDOR_SOURCE, records: vendor.records.length, revisedActions: vendor.revised },
    artifacts,
    reconcile: report,
  };

  // Create both outputs; never overwrite (checked above, and `wx` refuses a file that appeared since).
  writeFileSync(request.out, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" });
  writeFileSync(request.report, `${JSON.stringify(fullReport, null, 2)}\n`, { flag: "wx" });

  const ledger = new Ledger(deps.db, clock);
  const event = ledger.append(
    "corporate_actions.reconciled",
    { charterHash: loaded.charterHash, dataset, out: request.out, report: request.report, actionsHash: file.approval.actionsHash, counts: report.counts, toCurate: toCurate.length, artifacts, startedAt },
    nowUtc(clock),
  );
  return { out: request.out, report: request.report, dataset, charterHash: loaded.charterHash, actionsHash: file.approval.actionsHash, counts: report.counts, toCurate: toCurate.length, artifacts, ledgerSeq: event.seq };
}
