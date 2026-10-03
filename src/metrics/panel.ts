import type Database from "better-sqlite3";
import type { EvaluatorDef, InputRef, SignalDef } from "../config/schema.js";
import { getObservations, type ObsRow } from "../data/repositories/observations.js";
import { applyTransform } from "./transforms.js";

/**
 * Panel resolves signal inputs to transformed observation series on their
 * NATIVE frequency — no ffill-to-daily (that hides publication lag).
 * Cached per run so shared inputs are loaded once.
 */
export class Panel {
  private cache = new Map<string, ObsRow[]>();

  constructor(private conn?: Database.Database) {}

  resolve(ref: InputRef): ObsRow[] {
    const ck = `${ref.key}|${ref.transform}`;
    let obs = this.cache.get(ck);
    if (!obs) {
      obs = applyTransform(getObservations(ref.key, {}, this.conn), ref.transform);
      this.cache.set(ck, obs);
    }
    return obs;
  }

  /** All distinct input refs used by a signal (incl. branch overrides). */
  static signalInputs(signal: SignalDef): InputRef[] {
    const refs = new Map<string, InputRef>();
    const add = (r: InputRef) => refs.set(`${r.key}|${r.transform}`, r);
    add(signal.input);
    const walk = (ev: EvaluatorDef) => {
      if ("branches" in ev) ev.branches.forEach(walk);
      else if (ev.input) add(ev.input);
    };
    walk(signal.evaluator);
    return [...refs.values()];
  }

  /**
   * Latest RAW (untransformed) observation date among a signal's inputs.
   * Keyed on raw series — transforms can pin the transformed date
   * (e.g. monthly_mean emits YYYY-MM-01 all month) while new raw data
   * keeps arriving and should trigger re-evaluation.
   */
  latestObsDate(signal: SignalDef): string | null {
    let max: string | null = null;
    const keys = new Set(Panel.signalInputs(signal).map((r) => r.key));
    for (const key of keys) {
      const obs = getObservations(key, {}, this.conn);
      const d = obs.length ? obs[obs.length - 1].date : null;
      if (d && (!max || d > max)) max = d;
    }
    return max;
  }
}
