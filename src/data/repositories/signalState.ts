import type Database from "better-sqlite3";
import { getDb } from "../db.js";

export type SignalState = "ok" | "watch" | "warning" | "critical";

export const SEVERITY_ORDER: Record<SignalState, number> = {
  ok: 0,
  watch: 1,
  warning: 2,
  critical: 3,
};

export interface SignalStateRow {
  signal_key: string;
  state: SignalState;
  since: string | null;
  episode_start: string | null;
  last_value: number | null;
  last_obs_date: string | null;
  context_json: string | null;
}

export interface SignalEventRow {
  id: number;
  signal_key: string;
  ts: string;
  from_state: SignalState;
  to_state: SignalState;
  value: number | null;
  payload_json: string | null;
}

export function getSignalState(signalKey: string, conn?: Database.Database): SignalStateRow {
  const db = conn ?? getDb();
  const row = db.prepare("SELECT * FROM signal_state WHERE signal_key = ?").get(signalKey) as
    | SignalStateRow
    | undefined;
  return (
    row ?? {
      signal_key: signalKey,
      state: "ok",
      since: null,
      episode_start: null,
      last_value: null,
      last_obs_date: null,
      context_json: null,
    }
  );
}

export function getAllSignalStates(conn?: Database.Database): SignalStateRow[] {
  const db = conn ?? getDb();
  return db.prepare("SELECT * FROM signal_state").all() as SignalStateRow[];
}

/**
 * Persist new state; if it differs from stored, also insert a signal_events
 * row and return its id (the SignalEvent). Returns null when nothing changed.
 */
export function transitionSignalState(
  signalKey: string,
  next: {
    state: SignalState;
    since: string | null;
    episodeStart: string | null;
    value: number | null;
    obsDate: string | null;
    context?: Record<string, unknown>;
  },
  conn?: Database.Database,
): number | null {
  const db = conn ?? getDb();
  const prev = getSignalState(signalKey, db);

  return db.transaction(() => {
    db.prepare(
      `INSERT INTO signal_state (signal_key, state, since, episode_start, last_value, last_obs_date, context_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (signal_key) DO UPDATE SET
         state = excluded.state,
         since = excluded.since,
         episode_start = excluded.episode_start,
         last_value = excluded.last_value,
         last_obs_date = excluded.last_obs_date,
         context_json = excluded.context_json,
         updated_at = datetime('now')`,
    ).run(
      signalKey,
      next.state,
      next.since,
      next.episodeStart,
      next.value,
      next.obsDate,
      next.context ? JSON.stringify(next.context) : null,
    );

    if (prev.state === next.state) return null;

    const res = db
      .prepare(
        `INSERT INTO signal_events (signal_key, from_state, to_state, value, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(signalKey, prev.state, next.state, next.value, JSON.stringify(next.context ?? {}));
    return Number(res.lastInsertRowid);
  })();
}

export function getEvent(eventId: number, conn?: Database.Database): SignalEventRow | undefined {
  const db = conn ?? getDb();
  return db.prepare("SELECT * FROM signal_events WHERE id = ?").get(eventId) as
    | SignalEventRow
    | undefined;
}

export function getEventsSince(ts: string, conn?: Database.Database): SignalEventRow[] {
  const db = conn ?? getDb();
  return db.prepare("SELECT * FROM signal_events WHERE ts >= ? ORDER BY ts").all(ts) as SignalEventRow[];
}

export function getRecentEvents(hours: number, conn?: Database.Database): SignalEventRow[] {
  const db = conn ?? getDb();
  return db
    .prepare(
      `SELECT * FROM signal_events
       WHERE ts >= datetime('now', ?) ORDER BY ts`,
    )
    .all(`-${hours} hours`) as SignalEventRow[];
}

export function insertCompositeSnapshot(
  score: number,
  bucket: string,
  probLabel: string,
  detail: Record<string, unknown>,
  conn?: Database.Database,
): void {
  const db = conn ?? getDb();
  db.prepare(
    "INSERT INTO composite_snapshots (score, bucket, prob_label, detail_json) VALUES (?, ?, ?, ?)",
  ).run(score, bucket, probLabel, JSON.stringify(detail));
}

export function getLatestComposite(
  conn?: Database.Database,
): { score: number; bucket: string; prob_label: string; detail_json: string | null } | undefined {
  const db = conn ?? getDb();
  return db
    .prepare("SELECT score, bucket, prob_label, detail_json FROM composite_snapshots ORDER BY id DESC LIMIT 1")
    .get() as { score: number; bucket: string; prob_label: string; detail_json: string | null } | undefined;
}
