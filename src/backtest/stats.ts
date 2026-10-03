import type { SignalDef } from "../config/schema.js";
import { getConfig } from "../config/load.js";
import type { RecessionPeriod } from "../data/nber.js";
import {
  detectEpisodes,
  monthAdd,
  monthEnd,
  monthIndex,
  replaySignal,
  stateAt,
  type Episode,
  type SeriesCache,
} from "./replay.js";

export const HORIZON_MONTHS = 12;
/** A recession counts as "preceded" if an episode interval reaches this far before its start. */
export const RECALL_LOOKBACK_MONTHS = 24;

export interface SignalBacktest {
  signalKey: string;
  sampleStart: string;
  sampleEnd: string;
  episodes: Episode[];
  /** Open/near-end episodes whose 12m outcome is unknowable — excluded from precision. */
  censored: number;
  hits: number;
  precision: number | null;
  recessionsInSample: number;
  caught: number;
  recall: number | null;
  medianLeadMonths: number | null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const round2 = (x: number | null): number | null => (x === null ? null : Math.round(x * 100) / 100);

/**
 * Episode-level stats for one signal vs NBER recession starts.
 *  - hit: recession starts within (onset, onset + 12m]
 *  - censored: outcome window extends past the end of the USREC sample
 *  - recall: recession start is preceded by an episode overlapping
 *    [start - 24m, start]
 */
export function signalBacktest(
  signal: SignalDef,
  cache: SeriesCache,
  recessions: RecessionPeriod[],
  usrecLastMonth: string,
): SignalBacktest {
  const states = replaySignal(signal, cache);
  const episodes = detectEpisodes(states);
  const starts = recessions.map((r) => r.start);

  const sampleStart = states[0]?.date ?? "";
  const sampleEnd = states[states.length - 1]?.date ?? "";
  // last month for which the 12m outcome is fully observable
  const outcomeEnd = monthIndex(sampleEnd || "9999-12") - HORIZON_MONTHS;
  const knowableEnd = Math.min(outcomeEnd, monthIndex(usrecLastMonth) - HORIZON_MONTHS);

  let hits = 0;
  let censored = 0;
  let evaluable = 0;
  const leads: number[] = [];

  for (const ep of episodes) {
    const onset = monthIndex(ep.start);
    if (onset > knowableEnd) {
      censored++;
      continue;
    }
    evaluable++;
    const lead = starts
      .map((s) => monthIndex(s) - onset)
      .filter((d) => d > 0 && d <= HORIZON_MONTHS)
      .sort((a, b) => a - b)[0];
    if (lead !== undefined) {
      hits++;
      leads.push(lead);
    }
  }

  const recsInSample = starts.filter((s) => monthIndex(s) >= monthIndex(sampleStart));
  const caught = recsInSample.filter((rs) =>
    episodes.some((ep) => {
      const lo = monthIndex(rs) - RECALL_LOOKBACK_MONTHS;
      const hi = monthIndex(rs);
      return monthIndex(ep.start) <= hi && monthIndex(ep.end ?? ep.start) >= lo;
    }),
  ).length;

  return {
    signalKey: signal.key,
    sampleStart: sampleStart.slice(0, 7),
    sampleEnd: sampleEnd.slice(0, 7),
    episodes,
    censored,
    hits,
    precision: evaluable ? round2(hits / evaluable) : null,
    recessionsInSample: recsInSample.length,
    caught,
    recall: recsInSample.length ? round2(caught / recsInSample.length) : null,
    medianLeadMonths: median(leads),
  };
}

export interface ScoreRow {
  month: string;
  score: number;
  /** 1 if an NBER recession begins within the next 12 months. */
  outcome: number | null;
}

/**
 * Monthly grid of composite scores. Months already inside a recession get
 * outcome=null (the composite predicts *entry*, not persistence); the last
 * 12 months are outcome-unknown.
 */
export function compositeScoreGrid(
  signals: SignalDef[],
  cache: SeriesCache,
  recessions: RecessionPeriod[],
  usrecLastMonth: string,
): ScoreRow[] {
  const w = getConfig().model.composite.state_weight;
  const mult = (s: string) => (s === "watch" ? w.watch : s === "warning" ? w.warning : s === "critical" ? w.critical : 0);
  const weighted = signals.filter((s) => s.weight > 0);

  // union month range across inputs
  let first = "9999-12";
  let last = "0000-01";
  for (const sig of weighted) {
    const { obs } = cache.get(sig.input);
    if (!obs.length) continue;
    if (obs[0].date < first) first = obs[0].date;
    if (obs[obs.length - 1].date > last) last = obs[obs.length - 1].date;
  }
  if (first > last) return [];

  const startSet = new Set(recessions.map((r) => r.start));
  const inRec = new Set<string>();
  for (const r of recessions) {
    for (let m = r.start; m <= r.end; m = monthAdd(m, 1)) inRec.add(m);
  }
  const lastKnown = Math.min(monthIndex(last), monthIndex(usrecLastMonth)) - HORIZON_MONTHS;

  const rows: ScoreRow[] = [];
  for (let m = first.slice(0, 7); monthIndex(m) <= monthIndex(last); m = monthAdd(m, 1)) {
    const evalDate = monthEnd(m);
    let score = 0;
    for (const sig of weighted) score += sig.weight * mult(stateAt(sig, cache, evalDate));

    let outcome: number | null = null;
    if (!inRec.has(m) && monthIndex(m) <= lastKnown) {
      outcome = 0;
      for (let h = 1; h <= HORIZON_MONTHS; h++) {
        if (startSet.has(monthAdd(m, h))) {
          outcome = 1;
          break;
        }
      }
    }
    rows.push({ month: m, score, outcome });
  }
  return rows;
}

export interface BandCalibration {
  min: number;
  max: number;
  bucket: string;
  configured_label: string;
  n: number;
  hits: number;
  empirical: number | null;
}

/** Empirical P(recession within 12m) per configured score band. */
export function calibrateBands(rows: ScoreRow[]): BandCalibration[] {
  const bands = getConfig().model.composite.bands;
  return bands.map((b) => {
    const inBand = rows.filter((r) => r.score >= b.min && r.score <= b.max && r.outcome !== null);
    const hits = inBand.filter((r) => r.outcome === 1).length;
    return {
      min: b.min,
      max: b.max,
      bucket: b.bucket,
      configured_label: b.prob_label,
      n: inBand.length,
      hits,
      empirical: inBand.length ? round2(hits / inBand.length) : null,
    };
  });
}
