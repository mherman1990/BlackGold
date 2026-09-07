import { addDays, isoDate, weekday, type IsoDate } from "@blackgold/shared";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { AllowlistedHttpClient } from "../http.ts";
import { cotReleaseInstant } from "../lag-rules.ts";
import type { PointInTimeObservation } from "../pit/types.ts";
import {
  baseObservation,
  decimalString,
  fetchAndStore,
  midnightUtc,
  parseJsonBytes,
  SchemaDriftError,
  type AdapterContext,
  type FetchOutcome,
  type ParseContext,
} from "./common.ts";

/**
 * CFTC Commitments of Traders adapter (docs/DATA_PROVENANCE_SPEC.md section 3, "CFTC Commitments of Traders").
 * Positions are as of Tuesday; public release is Friday 15:30 ET, shifted by `cotReleaseInstant` when the
 * Friday is a holiday (RELEASE_DELAYED). observedAt = effectiveAt = the position date; availableAt = release.
 * Source: the CFTC public reporting API (Socrata). No token is required as of 2026-09-06.
 */
export const ADAPTER_VERSION = "1.0.0";
export const PARSER_VERSION = "1.0.0";
const VERSIONS = { adapterVersion: ADAPTER_VERSION, parserVersion: PARSER_VERSION };

export const COT_DATASETS = ["legacy_futures", "disaggregated_futures", "tff_futures"] as const;
export type CotDataset = (typeof COT_DATASETS)[number];

/**
 * Socrata dataset identifiers taken from https://publicreporting.cftc.gov (accessed 2026-09-06).
 * UNVERIFIED_DATASET_ID: these ids must be re-verified against the capability register before the first
 * production ingest; a wrong id fails loudly (HTTP 404 or SCHEMA_DRIFT), never silently.
 */
export const COT_SOCRATA_DATASET_IDS: Readonly<Record<CotDataset, string>> = {
  legacy_futures: "6dca-aqww",
  disaggregated_futures: "72hh-3qpy",
  tff_futures: "gpe5-46if",
};

const BASE = "https://publicreporting.cftc.gov/resource";
const DEFAULT_LIMIT = 50_000;

export function cotSourceId(dataset: CotDataset): string {
  return `cftc.cot.${dataset}`;
}

export type CotRow = {
  dataset: CotDataset;
  reportDate: IsoDate;
  marketCode: string;
  marketAndExchangeNames: string | null;
  commodityName: string | null;
  contractUnits: string | null;
  cftcMarketCode: string | null;
  cftcCommodityCode: string | null;
  /** Every numeric position/trader/percent column present in the row, as canonical decimal strings, keyed by the provider column name. */
  positions: Record<string, string>;
};

export type CotContext = AdapterContext & { dataset: CotDataset; marketCode?: string | undefined; from?: IsoDate | undefined; to?: IsoDate | undefined; limit?: number | undefined };

export function cotRequestUrl(ctx: Pick<CotContext, "dataset" | "marketCode" | "from" | "to" | "limit">): string {
  const url = new URL(`${BASE}/${COT_SOCRATA_DATASET_IDS[ctx.dataset]}.json`);
  const where: string[] = [];
  if (ctx.from !== undefined || ctx.to !== undefined) {
    const from = ctx.from ?? isoDate("1986-01-01");
    const to = ctx.to ?? isoDate("2100-12-31");
    where.push(`report_date_as_yyyy_mm_dd between '${from}T00:00:00.000' and '${to}T23:59:59.999'`);
  }
  if (ctx.marketCode !== undefined) {
    if (!/^[A-Za-z0-9+._-]+$/.test(ctx.marketCode)) throw new TypeError(`Unsafe market code: ${ctx.marketCode}`);
    where.push(`cftc_contract_market_code='${ctx.marketCode}'`);
  }
  if (where.length > 0) url.searchParams.set("$where", where.join(" AND "));
  url.searchParams.set("$order", "report_date_as_yyyy_mm_dd,cftc_contract_market_code");
  url.searchParams.set("$limit", (ctx.limit ?? DEFAULT_LIMIT).toString());
  return url.toString();
}

export async function fetchCot(client: AllowlistedHttpClient, store: ArtifactStore, ctx: CotContext): Promise<FetchOutcome<CotRow>> {
  const url = cotRequestUrl(ctx);
  const { put, ref } = await fetchAndStore(client, store, url, { locator: url, mime: "application/json", retention: "macro" });
  const observations = parseCot(store.get(put.hash), { calendar: ctx.calendar, ingestedAt: ctx.ingestedAt, rawContentHash: put.hash, dataset: ctx.dataset });
  return { artifacts: [ref], observations };
}

const RowSchema = z
  .object({ report_date_as_yyyy_mm_dd: z.string(), cftc_contract_market_code: z.string() })
  .catchall(z.union([z.string(), z.number(), z.null(), z.boolean(), z.record(z.string(), z.unknown())]));
const RowsSchema = z.array(RowSchema);

/** Provider columns that carry positions, trader counts, changes, concentration, or percentages. */
const NUMERIC_COLUMN_RE = /^(open_interest|noncomm_|comm_|tot_rept_|nonrept_|prod_merc_|swap_|m_money_|other_rept_|dealer_|asset_mgr_|lev_money_|change_|pct_of_|traders_|conc_)/;
const TEXT_COLUMNS = {
  marketAndExchangeNames: "market_and_exchange_names",
  commodityName: "commodity_name",
  contractUnits: "contract_units",
  cftcMarketCode: "cftc_market_code",
  cftcCommodityCode: "cftc_commodity_code",
} as const;

export type CotParseContext = ParseContext & { dataset: CotDataset };

/** Pure: one `cftc.cot.<dataset>` row per Socrata record. Locator: `cftc/cot/<dataset>/<market code>/<report date>`. */
export function parseCot(bytes: Uint8Array, ctx: CotParseContext): PointInTimeObservation<CotRow>[] {
  const sourceId = cotSourceId(ctx.dataset);
  const parsed = RowsSchema.safeParse(parseJsonBytes(bytes, sourceId));
  if (!parsed.success) throw new SchemaDriftError(sourceId, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data.map((row) => {
    const reportDate = isoDate(row.report_date_as_yyyy_mm_dd.slice(0, 10));
    const marketCode = row.cftc_contract_market_code.trim();
    const lag = releaseFor(reportDate, ctx);
    const positions: Record<string, string> = {};
    for (const key of Object.keys(row).sort()) {
      if (!NUMERIC_COLUMN_RE.test(key)) continue;
      const v = row[key];
      if (v === null || v === undefined || v === "") continue;
      if (typeof v === "string" || typeof v === "number") positions[key] = decimalString(v);
    }
    const text = (column: string): string | null => {
      const v = row[column];
      return typeof v === "string" && v !== "" ? v : null;
    };
    const value: CotRow = {
      dataset: ctx.dataset,
      reportDate,
      marketCode,
      marketAndExchangeNames: text(TEXT_COLUMNS.marketAndExchangeNames),
      commodityName: text(TEXT_COLUMNS.commodityName),
      contractUnits: text(TEXT_COLUMNS.contractUnits),
      cftcMarketCode: text(TEXT_COLUMNS.cftcMarketCode),
      cftcCommodityCode: text(TEXT_COLUMNS.cftcCommodityCode),
      positions,
    };
    return baseObservation(
      {
        sourceId,
        sourceLocator: `cftc/cot/${ctx.dataset}/${marketCode}/${reportDate}`,
        entityId: marketCode,
        observedAt: midnightUtc(reportDate),
        effectiveAt: midnightUtc(reportDate),
        availableAt: lag.availableAt,
        value,
        qualityFlags: lag.flags,
      },
      ctx,
      VERSIONS,
    );
  });
}

/**
 * Tuesday position dates use the release rule directly. When the report date is not a Tuesday (the CFTC compiles
 * as of Monday when Tuesday is a federal holiday), the release still follows that week's schedule: use the next
 * Tuesday on or after the date as the schedule anchor and mark the instant estimated.
 */
function releaseFor(reportDate: IsoDate, ctx: CotParseContext): { availableAt: PointInTimeObservation["availableAt"]; flags: string[] } {
  if (weekday(reportDate) === 2) return cotReleaseInstant(reportDate, ctx.calendar);
  let anchor = reportDate;
  while (weekday(anchor) !== 2) anchor = addDays(anchor, 1);
  const lag = cotReleaseInstant(anchor, ctx.calendar);
  return { availableAt: lag.availableAt, flags: [...lag.flags, "AVAILABLE_AT_ESTIMATED"] };
}
