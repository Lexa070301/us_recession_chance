import { getConfig, getSeriesDef } from "../config/load.js";
import type { Frequency } from "../config/schema.js";
import { getLatestObsDate, logFetch, upsertObservations, type ObsRow } from "./repositories/observations.js";

interface FredObservation {
  realtime_start: string;
  realtime_end: string;
  date: string;
  value: string;
}

interface FredError {
  error_code?: number;
  error_message?: string;
}

interface FredObservationsResponse extends FredError {
  observations?: FredObservation[];
}

interface FredVintagesResponse extends FredError {
  vintage_dates?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simple per-minute rate limiter shared across fetches. */
class RateLimiter {
  private count = 0;
  private windowStart = Date.now();

  constructor(private rpm: number) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.count = 0;
      this.windowStart = now;
    }
    if (this.count >= this.rpm) {
      await sleep(60_000 - (now - this.windowStart) + 50);
      this.count = 0;
      this.windowStart = Date.now();
    }
    this.count += 1;
  }
}

export class FredClient {
  private limiter: RateLimiter;
  private baseUrl: string;
  private apiKey: string;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor() {
    const cfg = getConfig();
    const fred = cfg.sources.data_sources.fred;
    const key = cfg.env.fredApiKey;
    if (!key) throw new Error("FRED_API_KEY is not set (see .env.example)");
    this.baseUrl = fred.base_url;
    this.apiKey = key;
    this.limiter = new RateLimiter(fred.rate_limit_rpm);
    this.maxRetries = fred.max_retries;
    this.retryDelayMs = fred.retry_delay_ms;
  }

  /** GET {path} with retries/rate-limiting; returns parsed JSON. */
  private async request<T extends FredError>(path: string, params: URLSearchParams): Promise<T> {
    params.set("api_key", this.apiKey);
    params.set("file_type", "json");
    const url = `${this.baseUrl}${path}?${params.toString()}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`FRED HTTP ${res.status}`);
        }
        const data = (await res.json()) as T;
        if (data.error_message) throw new Error(`FRED error: ${data.error_message}`);
        return data;
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) await sleep(this.retryDelayMs * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Fetch observations for a FRED series.
   * Pass vintageDates (YYYY-MM-DD) for ALFRED-mode vintage snapshots.
   */
  async fetchSeries(
    seriesId: string,
    opts: { startDate?: string; endDate?: string; vintageDates?: string[] } = {},
  ): Promise<ObsRow[]> {
    const params = new URLSearchParams({ series_id: seriesId });
    if (opts.startDate) params.set("observation_start", opts.startDate);
    if (opts.endDate) params.set("observation_end", opts.endDate);
    if (opts.vintageDates?.length) params.set("vintage_dates", opts.vintageDates.join(","));

    const data = await this.request<FredObservationsResponse>("/series/observations", params);
    return (data.observations ?? [])
      .filter((o) => o.value !== ".")
      .map((o) => ({ date: o.date, value: Number(o.value) }));
  }

  /**
   * All real vintage dates on which FRED stored a snapshot of the series
   * (fred/series/vintagedates). One cheap call — used to build a
   * monthly/quarterly backfill grid on actual release dates instead of
   * guessing arbitrary dates that may precede ALFRED coverage.
   */
  async fetchVintageDates(seriesId: string): Promise<string[]> {
    const data = await this.request<FredVintagesResponse>(
      "/series/vintagedates",
      new URLSearchParams({ series_id: seriesId }),
    );
    return data.vintage_dates ?? [];
  }

  /**
   * ALFRED batch: one API call covering up to ~100 vintage dates. Response
   * rows carry `realtime_start` = the vintage they belong to; each vintage
   * group is upserted under observations.vintage_date = realtime_start.
   */
  async fetchVintageBatch(
    seriesKey: string,
    vintageDates: string[],
    opts: { obsStart?: string } = {},
  ): Promise<{ vintage: string; rows: number }[]> {
    const def = getSeriesDef(seriesKey);
    if (!def?.series_id) throw new Error(`Unknown or non-FRED series key: ${seriesKey}`);
    const params = new URLSearchParams({
      series_id: def.series_id,
      vintage_dates: vintageDates.join(","),
    });
    if (opts.obsStart) params.set("observation_start", opts.obsStart);

    const data = await this.request<FredObservationsResponse>("/series/observations", params);
    const groups = new Map<string, ObsRow[]>();
    for (const o of data.observations ?? []) {
      if (o.value === ".") continue;
      const g = groups.get(o.realtime_start) ?? [];
      g.push({ date: o.date, value: Number(o.value) });
      groups.set(o.realtime_start, g);
    }
    const out: { vintage: string; rows: number }[] = [];
    for (const [vintage, rows] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      upsertObservations(seriesKey, rows, vintage);
      out.push({ vintage, rows: rows.length });
    }
    logFetch(seriesKey, "success", out.reduce((s, r) => s + r.rows, 0));
    return out;
  }

  /** Fetch + store one series; returns rows written. */
  async fetchAndStore(
    seriesKey: string,
    opts: { startDate?: string; endDate?: string; vintageDate?: string } = {},
  ): Promise<number> {
    const def = getSeriesDef(seriesKey);
    if (!def?.series_id) throw new Error(`Unknown or non-FRED series key: ${seriesKey}`);
    try {
      const rows = await this.fetchSeries(def.series_id, {
        startDate: opts.startDate,
        endDate: opts.endDate,
        vintageDates: opts.vintageDate ? [opts.vintageDate] : undefined,
      });
      upsertObservations(seriesKey, rows, opts.vintageDate ?? "");
      logFetch(seriesKey, "success", rows.length);
      return rows.length;
    } catch (err) {
      logFetch(seriesKey, "error", 0, String(err));
      throw err;
    }
  }
}

function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Incremental fetch: from last stored obs minus overlap (to catch revisions). */
export async function fetchIncremental(
  client: FredClient,
  seriesKey: string,
  overlapDays = 14,
): Promise<number> {
  const last = getLatestObsDate(seriesKey);
  const startDate = last ? plusDays(last, -overlapDays) : undefined;
  return client.fetchAndStore(seriesKey, { startDate });
}

export interface FetchSummary {
  series: Record<string, number>;
  errors: Record<string, string>;
  total: number;
}

export async function fetchAllSeries(
  opts: { frequency?: Frequency; backfillDays?: number; overlapDays?: number } = {},
): Promise<FetchSummary> {
  const cfg = getConfig();
  const client = new FredClient();
  const summary: FetchSummary = { series: {}, errors: {}, total: 0 };

  const defs = cfg.sources.series.filter(
    (s) => s.source === "fred" && (!opts.frequency || s.frequency === opts.frequency),
  );

  for (const def of defs) {
    try {
      let rows: number;
      if (opts.backfillDays) {
        const start = new Date(Date.now() - opts.backfillDays * 86_400_000).toISOString().slice(0, 10);
        rows = await client.fetchAndStore(def.key, { startDate: start });
      } else {
        rows = await fetchIncremental(client, def.key, opts.overlapDays ?? 14);
      }
      summary.series[def.key] = rows;
      summary.total += rows;
    } catch (err) {
      summary.errors[def.key] = String(err);
      console.error(`  ${def.key}: ERROR - ${err}`);
    }
  }
  return summary;
}

export async function backfillAll(years: number): Promise<FetchSummary> {
  return fetchAllSeries({ backfillDays: Math.round(years * 365.25), overlapDays: 0 });
}
