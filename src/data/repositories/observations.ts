import type Database from "better-sqlite3";
import { getDb } from "../db.js";

export interface ObsRow {
  date: string;
  value: number;
}

/** Upsert latest-revision observations (vintage_date = ''). */
export function upsertObservations(
  seriesKey: string,
  rows: ObsRow[],
  vintageDate = "",
  conn?: Database.Database,
): number {
  const db = conn ?? getDb();
  const stmt = db.prepare(
    `INSERT INTO observations (series_key, date, value, vintage_date, fetched_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (series_key, date, vintage_date)
     DO UPDATE SET value = excluded.value, fetched_at = datetime('now')`,
  );
  const tx = db.transaction((items: ObsRow[]) => {
    for (const r of items) stmt.run(seriesKey, r.date, r.value, vintageDate);
  });
  tx(rows);
  return rows.length;
}

export function getObservations(
  seriesKey: string,
  opts: { startDate?: string; endDate?: string; vintageDate?: string } = {},
  conn?: Database.Database,
): ObsRow[] {
  const db = conn ?? getDb();
  let sql = `SELECT date, value FROM observations WHERE series_key = ? AND vintage_date = ?`;
  const params: unknown[] = [seriesKey, opts.vintageDate ?? ""];
  if (opts.startDate) {
    sql += " AND date >= ?";
    params.push(opts.startDate);
  }
  if (opts.endDate) {
    sql += " AND date <= ?";
    params.push(opts.endDate);
  }
  sql += " ORDER BY date";
  return db.prepare(sql).all(...params) as ObsRow[];
}

export function getLatestObsDate(seriesKey: string, conn?: Database.Database): string | null {
  const db = conn ?? getDb();
  const row = db
    .prepare(`SELECT date FROM observations WHERE series_key = ? AND vintage_date = '' ORDER BY date DESC LIMIT 1`)
    .get(seriesKey) as { date: string } | undefined;
  return row?.date ?? null;
}

export function logFetch(
  seriesKey: string,
  status: "success" | "error",
  rows: number,
  error?: string,
  conn?: Database.Database,
): void {
  const db = conn ?? getDb();
  db.prepare("INSERT INTO fetch_log (series_key, status, rows, error) VALUES (?, ?, ?, ?)").run(
    seriesKey,
    status,
    rows,
    error ?? null,
  );
}
