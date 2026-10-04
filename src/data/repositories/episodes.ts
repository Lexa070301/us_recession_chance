import type Database from "better-sqlite3";
import { getDb } from "../db.js";

/**
 * signal_episodes — append-only replay cache for the self-audit (PLAN2 §6).
 * Pending episodes get re-evaluated weekly and flip to hit/fp once the
 * outcome window closes (INSERT OR REPLACE keeps the row current).
 */
export interface EpisodeRow {
  signal_key: string;
  start: string;
  end: string | null;
  peak: string | null;
  outcome: "hit" | "fp" | "pending" | null;
  evaluated_at: string;
}

export function upsertEpisode(
  e: {
    signalKey: string;
    start: string;
    end: string | null;
    peak: string;
    outcome: "hit" | "fp" | "pending";
  },
  conn?: Database.Database,
): void {
  const db = conn ?? getDb();
  db.prepare(
    `INSERT OR REPLACE INTO signal_episodes (signal_key, start, end, peak, outcome)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(e.signalKey, e.start, e.end, e.peak, e.outcome);
}

export function listEpisodes(
  signalKey?: string,
  conn?: Database.Database,
): EpisodeRow[] {
  const db = conn ?? getDb();
  return (
    signalKey
      ? db.prepare("SELECT * FROM signal_episodes WHERE signal_key = ? ORDER BY start")
      : db.prepare("SELECT * FROM signal_episodes ORDER BY signal_key, start")
  ).all(...(signalKey ? [signalKey] : [])) as EpisodeRow[];
}
