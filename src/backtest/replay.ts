import type Database from "better-sqlite3";
import { getSeriesDef } from "../config/load.js";
import type { Frequency, InputRef, SignalDef } from "../config/schema.js";
import { getObservations, type ObsRow } from "../data/repositories/observations.js";
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
