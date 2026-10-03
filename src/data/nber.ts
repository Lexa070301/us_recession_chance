import type Database from "better-sqlite3";
import { getDb } from "./db.js";
import { getObservations } from "./repositories/observations.js";

export interface RecessionPeriod {
  start: string; // YYYY-MM (first month flagged by USREC)
  end: string; // YYYY-MM (last month flagged)
}

/**
 * Derive NBER recession periods from the USREC series stored in observations
 * (monthly, 1 = recession month). Requires `usrec` series to be fetched.
 */
export function getRecessionPeriods(conn?: Database.Database): RecessionPeriod[] {
  const db = conn ?? getDb();
  const obs = getObservations("usrec", {}, db);
  const periods: RecessionPeriod[] = [];
  let cur: RecessionPeriod | null = null;

  for (const { date, value } of obs) {
    const month = date.slice(0, 7);
    if (value >= 0.5) {
      if (!cur) cur = { start: month, end: month };
      else cur.end = month;
    } else if (cur) {
      periods.push(cur);
      cur = null;
    }
  }
  if (cur) periods.push(cur);
  return periods;
}

/** Is the given YYYY-MM month inside a recession period? */
export function isRecessionMonth(month: string, periods: RecessionPeriod[]): boolean {
  return periods.some((p) => month >= p.start && month <= p.end);
}
