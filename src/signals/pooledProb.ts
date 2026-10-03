import type Database from "better-sqlite3";
import { getConfig } from "../config/load.js";
import { getObservations, type ObsRow } from "../data/repositories/observations.js";
import { monthlyMean, movingAverage, diff, pctChange } from "../metrics/transforms.js";

const sigmoid = (z: number): number =>
  z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

function applyOps(obs: ObsRow[], ops: { t: string; n?: number }[]): ObsRow[] {
  let out = obs;
  for (const op of ops) {
    switch (op.t) {
      case "monthly_mean":
        out = monthlyMean(out);
        break;
      case "ma":
        out = movingAverage(out, op.n ?? 1);
        break;
      case "diff":
        out = diff(out, op.n ?? 1);
        break;
      case "pct_change":
        out = pctChange(out, op.n ?? 1);
        break;
    }
  }
  return out;
}

/**
 * Pooled-logit 12-month recession probability from `model.pooled_logit`
 * (fitted offline by scripts/fitModel.ts). Returns null when the model is
 * not configured or a predictor has no data.
 *
 * Approximation: each predictor takes its latest computed value regardless
 * of publication lag — for a monthly model the worst skew is ~1 month.
 */
export function computePooledProb(conn?: Database.Database): number | null {
  const spec = getConfig().model.pooled_logit;
  if (!spec) return null;

  let z = spec.intercept;
  for (const p of spec.predictors) {
    const series = applyOps(getObservations(p.key, {}, conn), p.ops);
    const last = series[series.length - 1];
    if (!last) return null;
    z += p.coef * ((last.value - p.mean) / p.std);
  }
  return sigmoid(z);
}

/** Coarse display bucket for a probability — avoids pseudo-precision. */
export function probBucketLabel(p: number): string {
  if (p < 0.1) return "<10%";
  if (p < 0.25) return "10–25%";
  if (p < 0.5) return "25–50%";
  return ">50%";
}
