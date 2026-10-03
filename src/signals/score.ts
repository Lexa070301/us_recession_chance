import type { SignalDef } from "../config/schema.js";
import { getConfig } from "../config/load.js";
import type { SignalStateRow } from "../data/repositories/signalState.js";

export interface CompositeResult {
  score: number;
  bucket: string;
  probLabel: string;
  detail: Record<string, { state: string; weight: number; contribution: number }>;
  /** Pooled-logit model estimate (0–1) when model.pooled_logit is configured. */
  modelProb?: number | null;
}

export function computeComposite(
  states: Map<string, SignalStateRow>,
  signals: SignalDef[],
): CompositeResult {
  const cfg = getConfig().model.composite;
  const w = cfg.state_weight;
  const detail: CompositeResult["detail"] = {};
  let score = 0;

  for (const sig of signals) {
    if (sig.weight <= 0) continue;
    const st = states.get(sig.key)?.state ?? "ok";
    const mult = st === "ok" ? 0 : st === "watch" ? w.watch : st === "warning" ? w.warning : w.critical;
    const contribution = sig.weight * mult;
    detail[sig.key] = { state: st, weight: sig.weight, contribution };
    score += contribution;
  }

  const band = cfg.bands.find((b) => score >= b.min && score <= b.max) ?? cfg.bands[0];
  return { score, bucket: band.bucket, probLabel: band.prob_label, detail };
}
