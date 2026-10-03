import { getConfig, getSeriesDef } from "../config/load.js";
import type { Frequency } from "../config/schema.js";
import { getLatestObsDate, logFetch, upsertObservations, type ObsRow } from "./repositories/observations.js";

interface FredObservation {
  realtime_start: string;
  realtime_end: string;
  date: string;
  value: string;
}

interface FredObservationsResponse {
  observations?: FredObservation[];
  error_code?: number;
  error_message?: string;
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

  /**
   * Fetch observations for a FRED series.
   * Pass vintageDates (YYYY-MM-DD) for ALFRED-mode vintage snapshots.
   */
  async fetchSeries(
    seriesId: string,
    opts: { startDate?: string; endDate?: string; vintageDates?: string[] } = {},
  ): Promise<ObsRow[]> {
    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: this.apiKey,
      file_type: "json",
    });
    if (opts.startDate) params.set("observation_start", opts.startDate);
    if (opts.endDate) params.set("observation_end", opts.endDate);
    if (opts.vintageDates?.length) params.set("vintage_dates", opts.vintageDates.join(","));

    const url = `${this.baseUrl}/series/observations?${params.toString()}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`FRED HTTP ${res.status}`);
        }
        const data = (await res.json()) as FredObservationsResponse;
        if (data.error_message) throw new Error(`FRED error: ${data.error_message}`);

        return (data.observations ?? [])
          .filter((o) => o.value !== ".")
          .map((o) => ({ date: o.date, value: Number(o.value) }));
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) await sleep(this.retryDelayMs * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
