import type { SignalState } from "../data/repositories/signalState.js";
import type { ObsRow } from "../data/repositories/observations.js";
import type { InputRef } from "../config/schema.js";

export type { SignalState };

export interface EvalResult {
  state: SignalState;
  /** Latest observed value of the evaluated (transformed) input. */
  value: number | null;
  /** Date the current state/episode started (null when state = ok). */
  since: string | null;
  /** Evaluator-specific details for logs/messages. */
  context: Record<string, unknown>;
}

export type GetObs = (ref?: InputRef) => ObsRow[];

/** Previously stored state — needed for hysteresis (exit_below/exit_above). */
export interface PrevEvalState {
  state: SignalState;
  since: string | null;
}
