import type Database from "better-sqlite3";
import { getSeriesDef } from "../config/load.js";
import type { Frequency, InputRef, SignalDef } from "../config/schema.js";
import {
  getObservations,
  getVintageDates,
  observationsAsOf,
  type ObsRow,
} from "../data/repositories/observations.js";
import { SEVERITY_ORDER, type SignalState } from "../data/repositories/signalState.js";
import { applyTransform } from "../metrics/transforms.js";
import { YOY_PERIODS } from "../signals/engine.js";
import { evaluate } from "../signals/evaluators.js";

/**
 * Approximate publication lag: at wall-clock date T, an observation dated D is
 * only "known" if D + lag <= T. This approximates real release calendars
 * (monthly data ~4–6 weeks, SLOOS ~quarter+6w) so a backtest doesn't peek at
 * not-yet-published numbers. Latest-vintage values are used, so revised
 * history still leaks a little — documented limitation.
 */
export const PUBLISH_LAG_DAYS: Record<Frequency, number> = {
  daily: 1,
  weekly: 7,
  monthly: 45,
  quarterly: 90,
};

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Month index for YYYY-MM[-DD] — comparable across dates. */
export function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

export function monthAdd(date: string, months: number): string {
  const idx = monthIndex(date) + months;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

/** Last calendar day of the given YYYY-MM month. */
export function monthEnd(month: string): string {
  return addDays(`${monthAdd(`${month}-01`, 1)}-01`, -1);
}

const refKey = (r: InputRef) => `${r.key}|${r.transform}`;

/** Transforms that aggregate to a coarser (monthly) grid — the publish lag
 * must apply to the aggregated period, not the raw series' frequency.
 * Otherwise a monthly value dated YYYY-MM-01 would be "known" on the 2nd
 * although it physically needs the whole month's data. */
const AGGREGATING_TRANSFORMS = new Set(["monthly_mean", "nyfed_prob"]);

/** Transformed input series, loaded once and shared across a backtest run. */
export class SeriesCache {
  private cache = new Map<string, { obs: ObsRow[]; freq: Frequency }>();

  constructor(private conn?: Database.Database) {}

  get(ref: InputRef): { obs: ObsRow[]; freq: Frequency } {
    let e = this.cache.get(refKey(ref));
    if (!e) {
      const def = getSeriesDef(ref.key);
      const rawFreq = def?.frequency ?? "monthly";
      e = {
        obs: applyTransform(getObservations(ref.key, {}, this.conn), ref.transform),
        freq: AGGREGATING_TRANSFORMS.has(ref.transform) ? "monthly" : rawFreq,
      };
      this.cache.set(refKey(ref), e);
    }
    return e;
  }
}

/** Index of the last obs with date <= cutoff, or -1. */
function prefixEnd(obs: ObsRow[], cutoff: string): number {
  let lo = 0;
  let hi = obs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (obs[mid].date <= cutoff) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Series prefix knowable at evalDate (obs.date + publish lag <= evalDate). */
export function knownAt(cache: SeriesCache, ref: InputRef, evalDate: string): ObsRow[] {
  const { obs, freq } = cache.get(ref);
  const end = prefixEnd(obs, addDays(evalDate, -PUBLISH_LAG_DAYS[freq]));
  return end < 0 ? [] : obs.slice(0, end + 1);
}

export interface StatePoint {
  date: string;
  state: SignalState;
}

/**
 * Replay a signal over history: at each main-input observation's knowledge
 * date, evaluate exactly as the live engine would have. Returns the state
 * time series on the input's native frequency.
 */
export function replaySignal(signal: SignalDef, cache: SeriesCache): StatePoint[] {
  const { obs, freq } = cache.get(signal.input);
  const lag = PUBLISH_LAG_DAYS[freq];
  const out: StatePoint[] = [];
  let prev: { state: SignalState; since: string | null } | undefined;
  for (const o of obs) {
    const evalDate = addDays(o.date, lag);
    const res = evaluate(
      signal.evaluator,
      (ref) => knownAt(cache, ref ?? signal.input, evalDate),
      YOY_PERIODS[freq],
      prev,
    );
    prev = { state: res.state, since: res.since };
    out.push({ date: evalDate, state: res.state });
  }
  return out;
}

/** Signal state at a single wall-clock date (publication-lag aware). */
export function stateAt(signal: SignalDef, cache: SeriesCache, evalDate: string): SignalState {
  const freq = cache.get(signal.input).freq;
  return evaluate(
    signal.evaluator,
    (ref) => knownAt(cache, ref ?? signal.input, evalDate),
    YOY_PERIODS[freq],
  ).state;
}

// ------------------------------------------------------------------
// ALFRED as-of mode (PLAN2 §1)
// ------------------------------------------------------------------

/**
 * Point-in-time data source: each input resolves to the reconstruction of
 * stored vintage deltas <= evalDate (true no-look-ahead — revisions can't
 * leak in). Series without any stored vintages resolve to the latest
 * revision: the vintage backfill only covers revisable real-activity
 * series, and market series are effectively never revised.
 */
export class VintageSeriesCache {
  private vintages = new Map<string, string[]>();
  private cache = new Map<string, { obs: ObsRow[]; freq: Frequency }>();

  constructor(private conn?: Database.Database) {}

  private vintageList(key: string): string[] {
    let v = this.vintages.get(key);
    if (!v) {
      v = getVintageDates(key, this.conn);
      this.vintages.set(key, v);
    }
    return v;
  }

  /**
   * Cache label for as-of resolution: the latest vintage <= evalDate.
   * All evalDates sharing it resolve to the same reconstructed series.
   * '' for vintage-free series; null = nothing was knowable yet.
   */
  vintageAt(key: string, evalDate: string): string | null {
    const list = this.vintageList(key);
    if (!list.length) return "";
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= evalDate) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans < 0 ? null : list[ans];
  }

  /** Transformed input as known at evalDate (vintage-delta reconstruction). */
  get(ref: InputRef, evalDate: string): { obs: ObsRow[]; freq: Frequency } {
    const def = getSeriesDef(ref.key);
    const rawFreq = def?.frequency ?? "monthly";
    const freq = AGGREGATING_TRANSFORMS.has(ref.transform) ? "monthly" : rawFreq;
    const vintage = this.vintageAt(ref.key, evalDate);
    if (vintage === null) return { obs: [], freq };

    const ck = `${refKey(ref)}|${vintage}`;
    let e = this.cache.get(ck);
    if (!e) {
      const raw =
        vintage === ""
          ? getObservations(ref.key, {}, this.conn)
          : observationsAsOf(ref.key, evalDate, {}, this.conn);
      e = { obs: applyTransform(raw, ref.transform), freq };
      this.cache.set(ck, e);
    }
    if (vintage === "") {
      // Vintage-free series: the latest revision doesn't embody the release
      // delay, so fall back to publication-lag truncation (same as knownAt).
      const end = prefixEnd(e.obs, addDays(evalDate, -PUBLISH_LAG_DAYS[freq]));
      return { obs: end < 0 ? [] : e.obs.slice(0, end + 1), freq };
    }
    return e;
  }

  /** Latest-revision input (vintage_date='') — defines the evaluation grid. */
  latest(ref: InputRef): { obs: ObsRow[]; freq: Frequency } {
    const def = getSeriesDef(ref.key);
    const rawFreq = def?.frequency ?? "monthly";
    const freq = AGGREGATING_TRANSFORMS.has(ref.transform) ? "monthly" : rawFreq;
    const ck = `${refKey(ref)}|`;
    let e = this.cache.get(ck);
    if (!e) {
      e = {
        obs: applyTransform(getObservations(ref.key, {}, this.conn), ref.transform),
        freq,
      };
      this.cache.set(ck, e);
    }
    return e;
  }
}

/**
 * As-of replay: the SAME evaluation-date grid as replaySignal (each input
 * obs's publication date — native frequency is preserved), but every input
 * resolves to the latest vintage <= evalDate. No extra publish lag on top:
 * the vintage snapshot itself embodies the release delay.
 */
export function replaySignalAsof(signal: SignalDef, cache: VintageSeriesCache): StatePoint[] {
  const { obs, freq } = cache.latest(signal.input);
  const lag = PUBLISH_LAG_DAYS[freq];
  const out: StatePoint[] = [];
  let prev: { state: SignalState; since: string | null } | undefined;
  for (const o of obs) {
    const evalDate = addDays(o.date, lag);
    const res = evaluate(
      signal.evaluator,
      (ref) => cache.get(ref ?? signal.input, evalDate).obs,
      YOY_PERIODS[freq],
      prev,
    );
    prev = { state: res.state, since: res.since };
    out.push({ date: evalDate, state: res.state });
  }
  return out;
}

/** As-of signal state at a wall-clock date. */
export function stateAtAsof(
  signal: SignalDef,
  cache: VintageSeriesCache,
  evalDate: string,
): SignalState {
  const freq = cache.get(signal.input, evalDate).freq;
  return evaluate(
    signal.evaluator,
    (ref) => cache.get(ref ?? signal.input, evalDate).obs,
    YOY_PERIODS[freq],
  ).state;
}

// ------------------------------------------------------------------
// BacktestSource: uniform interface for stats.ts over either mode
// ------------------------------------------------------------------

export interface BacktestSource {
  /** Input series defining the sample range (latest available data). */
  inputObs(signal: SignalDef): { obs: ObsRow[]; freq: Frequency };
  replay(signal: SignalDef): StatePoint[];
  stateAt(signal: SignalDef, evalDate: string): SignalState;
}

export function latestSource(cache: SeriesCache): BacktestSource {
  return {
    inputObs: (s) => cache.get(s.input),
    replay: (s) => replaySignal(s, cache),
    stateAt: (s, d) => stateAt(s, cache, d),
  };
}

export function asofSource(cache: VintageSeriesCache): BacktestSource {
  return {
    inputObs: (s) => cache.latest(s.input),
    replay: (s) => replaySignalAsof(s, cache),
    stateAt: (s, d) => stateAtAsof(s, cache, d),
  };
}

export interface Episode {
  start: string;
  end: string | null; // first ok date after the run; null = still active at sample end
  peak: SignalState;
}

const maxState = (a: SignalState, b: SignalState): SignalState =>
  SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;

/**
 * Contiguous non-ok runs -> episodes. Runs separated by < minOkGapMonths are
 * merged (per scripts/histStats.md: a new episode requires >=6 months quiet).
 */
export function detectEpisodes(states: StatePoint[], minOkGapMonths = 6): Episode[] {
  const raw: Episode[] = [];
  let cur: Episode | null = null;
  for (const p of states) {
    if (p.state === "ok") {
      if (cur) {
        cur.end = p.date;
        raw.push(cur);
        cur = null;
      }
    } else if (cur) {
      cur.peak = maxState(cur.peak, p.state);
    } else {
      cur = { start: p.date, end: null, peak: p.state };
    }
  }
  if (cur) raw.push(cur);

  const merged: Episode[] = [];
  for (const ep of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.end && monthIndex(ep.start) - monthIndex(prev.end) < minOkGapMonths) {
      prev.end = ep.end;
      prev.peak = maxState(prev.peak, ep.peak);
    } else {
      merged.push({ ...ep });
    }
  }
  return merged;
}
