import type Database from "better-sqlite3";
import { getConfig, getSeriesDef } from "../config/load.js";
import type { Frequency } from "../config/schema.js";
import { getDb } from "../data/db.js";
import {
  getAllSignalStates,
  getEvent,
  getLatestComposite,
  getSignalState,
  insertCompositeSnapshot,
  transitionSignalState,
  type SignalEventRow,
} from "../data/repositories/signalState.js";
import { Panel } from "../metrics/panel.js";
import { evaluate } from "./evaluators.js";
import { computeComposite, type CompositeResult } from "./score.js";

const YOY_PERIODS: Record<Frequency, number> = {
  daily: 252,
  weekly: 52,
  monthly: 12,
  quarterly: 4,
};

export interface EngineRun {
  events: SignalEventRow[];
  composite: CompositeResult;
  evaluated: number;
  skipped: number;
}

/**
 * Evaluate all configured signals. A signal is re-evaluated only when its
 * inputs have new observations since the last run (publication-lag aware:
 * we key on real observation dates, not wall-clock ffilled dates).
 * Emits a SignalEvent row only on state transitions.
 */
export function runEngine(conn?: Database.Database): EngineRun {
  const db = conn ?? getDb();
  const cfg = getConfig();
  const panel = new Panel(db);
  const events: SignalEventRow[] = [];
  let evaluated = 0;
  let skipped = 0;

  for (const signal of cfg.signals) {
    const latestObsDate = panel.latestObsDate(signal);
    const stored = getSignalState(signal.key, db);

    if (!latestObsDate) {
      skipped++;
      continue;
    }
    if (stored.last_obs_date === latestObsDate && stored.last_obs_date !== null) {
      skipped++;
      continue;
    }

    const inputFreq = getSeriesDef(signal.input.key)?.frequency ?? "monthly";
    const result = evaluate(
      signal.evaluator,
      (ref) => panel.resolve(ref ?? signal.input),
      YOY_PERIODS[inputFreq],
    );

    const eventId = transitionSignalState(
      signal.key,
      {
        state: result.state,
        since: result.since,
        episodeStart: result.state === "ok" ? null : result.since,
        value: result.value,
        obsDate: latestObsDate,
        context: { ...result.context, since: result.since },
      },
      db,
    );
    evaluated++;
    if (eventId !== null) {
      const ev = getEvent(eventId, db);
      if (ev) events.push(ev);
    }
  }

  // Composite snapshot: on any transition, or when score moved.
  const states = new Map(getAllSignalStates(db).map((s) => [s.signal_key, s]));
  const composite = computeComposite(states, cfg.signals);
  const prev = getLatestComposite(db);
  if (events.length > 0 || !prev || prev.score !== composite.score || prev.bucket !== composite.bucket) {
    insertCompositeSnapshot(composite.score, composite.bucket, composite.probLabel, composite.detail, db);
  }

  return { events, composite, evaluated, skipped };
}
