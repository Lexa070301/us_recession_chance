import { getConfig } from "../config/load.js";
import type { ObsRow } from "../data/repositories/observations.js";

/**
 * Transform registry. All functions are pure: ObsRow[] (asc by date) -> ObsRow[].
 * Names must match `transform` fields in config/signals.yaml.
 */

export function movingAverage(obs: ObsRow[], window: number): ObsRow[] {
  const out: ObsRow[] = [];
  for (let i = 0; i < obs.length; i++) {
    if (i + 1 < window) continue;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += obs[j].value;
    out.push({ date: obs[i].date, value: sum / window });
  }
  return out;
}

export function diff(obs: ObsRow[], periods: number): ObsRow[] {
  const out: ObsRow[] = [];
  for (let i = periods; i < obs.length; i++) {
    out.push({ date: obs[i].date, value: obs[i].value - obs[i - periods].value });
  }
  return out;
}

export function pctChange(obs: ObsRow[], periods: number): ObsRow[] {
  const out: ObsRow[] = [];
  for (let i = periods; i < obs.length; i++) {
    const prev = obs[i - periods].value;
    if (prev === 0) continue;
    out.push({ date: obs[i].date, value: ((obs[i].value - prev) / Math.abs(prev)) * 100 });
  }
  return out;
}

/** Monthly mean of a (usually daily) series -> one obs per calendar month. */
export function monthlyMean(obs: ObsRow[]): ObsRow[] {
  const byMonth = new Map<string, { sum: number; n: number }>();
  for (const { date, value } of obs) {
    const m = date.slice(0, 7);
    const acc = byMonth.get(m) ?? { sum: 0, n: 0 };
    acc.sum += value;
    acc.n += 1;
    byMonth.set(m, acc);
  }
  return [...byMonth.entries()].map(([month, { sum, n }]) => ({
    date: `${month}-01`,
    value: sum / n,
  }));
}

const normCdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

function erf(x: number): number {
  // Abramowitz–Stegun 7.1.26, |err| < 1.5e-7
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

/**
 * NY Fed probit: P(recession within 12m) = N(alpha + beta * monthly-mean spread),
 * expressed in percent. Coefficients from config/model.yaml.
 */
export function nyfedProb(obs: ObsRow[]): ObsRow[] {
  const { alpha, beta } = getConfig().model.nyfed_probit;
  return monthlyMean(obs).map((o) => ({
    date: o.date,
    value: normCdf(alpha + beta * o.value) * 100,
  }));
}

/**
 * Sahm-rule transform (monthly): MA3(value) − min(MA3 over trailing 12m).
 * A state/national series is "triggered" when the result ≥ ~0.5.
 * Needs ≥14 monthly obs (3 for MA + 12 for the trailing min).
 */
export function sahmRule(obs: ObsRow[]): ObsRow[] {
  const ma = movingAverage(obs, 3);
  const out: ObsRow[] = [];
  for (let i = 0; i < ma.length; i++) {
    const win = ma.slice(Math.max(0, i - 11), i + 1);
    if (win.length < 12) continue;
    const min = Math.min(...win.map((o) => o.value));
    out.push({ date: ma[i].date, value: ma[i].value - min });
  }
  return out;
}

export type TransformFn = (obs: ObsRow[]) => ObsRow[];

const REGISTRY: Record<string, TransformFn> = {
  value: (o) => o,
  sahm: sahmRule,
  ma3: (o) => movingAverage(o, 3),
  ma4: (o) => movingAverage(o, 4),
  ma13: (o) => movingAverage(o, 13),
  ma6: (o) => movingAverage(o, 6),
  monthly_mean: monthlyMean,
  nyfed_prob: nyfedProb,
};

export function applyTransform(obs: ObsRow[], name: string): ObsRow[] {
  const fn = REGISTRY[name];
  if (!fn) throw new Error(`Unknown transform: ${name}`);
  return fn(obs);
}
