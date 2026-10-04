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

// ------------------------------------------------------------------
// ALFRED vintages (rows with vintage_date != '')
// ------------------------------------------------------------------

/** Distinct vintage dates stored for a series, ascending ('' excluded). */
export function getVintageDates(seriesKey: string, conn?: Database.Database): string[] {
  const db = conn ?? getDb();
  return (
    db
      .prepare(
        `SELECT DISTINCT vintage_date FROM observations
         WHERE series_key = ? AND vintage_date != '' ORDER BY vintage_date`,
      )
      .all(seriesKey) as { vintage_date: string }[]
  ).map((r) => r.vintage_date);
}

/** Latest stored vintage on/before asOfDate; null when none exists. */
export function latestVintageAt(
  seriesKey: string,
  asOfDate: string,
  conn?: Database.Database,
): string | null {
  const db = conn ?? getDb();
  const row = db
    .prepare(
      `SELECT MAX(vintage_date) AS v FROM observations
       WHERE series_key = ? AND vintage_date != '' AND vintage_date <= ?`,
    )
    .get(seriesKey, asOfDate) as { v: string | null };
  return row.v;
}

/**
 * Observations as they were known on asOfDate — point-in-time reconstruction.
 *
 * FRED vintage fetches store DELTAS, not full snapshots: a row
 * (series, date, vintage) is the value for `date` as it became valid in that
 * vintage, and it stays valid until a later vintage revises it. So the as-of
 * series is, per observation date, the value from the latest vintage <= asOf.
 *
 * Returns [] when no vintage exists on/before asOfDate — deliberately NOT a
 * fallback to the latest revision ('' rows), which would leak revised data.
 * Callers handling vintage-free series should check getVintageDates() first.
 */
export function observationsAsOf(
  seriesKey: string,
  asOfDate: string,
  opts: { startDate?: string; endDate?: string } = {},
  conn?: Database.Database,
): ObsRow[] {
  const db = conn ?? getDb();
  let sql = `
    SELECT o.date, o.value FROM observations o
    JOIN (
      SELECT date, MAX(vintage_date) AS v
      FROM observations
      WHERE series_key = ? AND vintage_date != '' AND vintage_date <= ?
      GROUP BY date
    ) m ON m.date = o.date AND m.v = o.vintage_date
    WHERE o.series_key = ? AND o.vintage_date != ''`;
  const params: unknown[] = [seriesKey, asOfDate, seriesKey];
  if (opts.startDate) {
    sql += " AND o.date >= ?";
    params.push(opts.startDate);
  }
  if (opts.endDate) {
    sql += " AND o.date <= ?";
    params.push(opts.endDate);
  }
  sql += " ORDER BY o.date";
  return db.prepare(sql).all(...params) as ObsRow[];
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
