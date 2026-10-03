import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import type { SignalState } from "./signalState.js";

export interface UserRow {
  tg_user_id: number;
  username: string | null;
  locale: string;
  plan: "free" | "plus";
  is_blocked: number;
}

export interface UserPrefs {
  user_id: number;
  enabled_signals: string[] | null; // null = all signals
  min_severity: Exclude<SignalState, "ok">;
  delivery_mode: "instant" | "digest";
  digest_time: string | null;
  quiet_hours: { from: number; to: number } | null;
}

export function upsertUser(
  tgUserId: number,
  username: string | null,
  locale: string,
  conn?: Database.Database,
): void {
  const db = conn ?? getDb();
  db.prepare(
    `INSERT INTO users (tg_user_id, username, locale, last_seen_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (tg_user_id) DO UPDATE SET
       username = excluded.username,
       last_seen_at = datetime('now')`,
  ).run(tgUserId, username, locale);
  db.prepare(
    `INSERT OR IGNORE INTO user_prefs (user_id) VALUES (?)`,
  ).run(tgUserId);
}

export function getUser(tgUserId: number, conn?: Database.Database): UserRow | undefined {
  const db = conn ?? getDb();
  return db.prepare("SELECT * FROM users WHERE tg_user_id = ?").get(tgUserId) as UserRow | undefined;
}

export function setUserLocale(tgUserId: number, locale: string, conn?: Database.Database): void {
  const db = conn ?? getDb();
  db.prepare("UPDATE users SET locale = ? WHERE tg_user_id = ?").run(locale, tgUserId);
}

export function setUserPlan(tgUserId: number, plan: "free" | "plus", conn?: Database.Database): void {
  const db = conn ?? getDb();
  db.prepare("UPDATE users SET plan = ? WHERE tg_user_id = ?").run(plan, tgUserId);
}

export function setBlocked(tgUserId: number, blocked: boolean, conn?: Database.Database): void {
  const db = conn ?? getDb();
  db.prepare("UPDATE users SET is_blocked = ? WHERE tg_user_id = ?").run(blocked ? 1 : 0, tgUserId);
}

export function getPrefs(tgUserId: number, conn?: Database.Database): UserPrefs {
  const db = conn ?? getDb();
  const row = db.prepare("SELECT * FROM user_prefs WHERE user_id = ?").get(tgUserId) as
    | {
        user_id: number;
        enabled_signals_json: string | null;
        min_severity: string;
        delivery_mode: string;
        digest_time: string | null;
        quiet_hours_json: string | null;
      }
    | undefined;
  return {
    user_id: tgUserId,
    enabled_signals: row?.enabled_signals_json ? (JSON.parse(row.enabled_signals_json) as string[]) : null,
    min_severity: (row?.min_severity as UserPrefs["min_severity"]) ?? "warning",
    delivery_mode: (row?.delivery_mode as UserPrefs["delivery_mode"]) ?? "digest",
    digest_time: row?.digest_time ?? null,
    quiet_hours: row?.quiet_hours_json ? (JSON.parse(row.quiet_hours_json) as UserPrefs["quiet_hours"]) : null,
  };
}

export function savePrefs(tgUserId: number, prefs: Partial<UserPrefs>, conn?: Database.Database): void {
  const db = conn ?? getDb();
  db.prepare("INSERT OR IGNORE INTO user_prefs (user_id) VALUES (?)").run(tgUserId);
  const cur = getPrefs(tgUserId, db);
  const next = { ...cur, ...prefs };
  db.prepare(
    `UPDATE user_prefs SET enabled_signals_json = ?, min_severity = ?, delivery_mode = ?, digest_time = ?, quiet_hours_json = ?
     WHERE user_id = ?`,
  ).run(
    next.enabled_signals ? JSON.stringify(next.enabled_signals) : null,
    next.min_severity,
    next.delivery_mode,
    next.digest_time,
    next.quiet_hours ? JSON.stringify(next.quiet_hours) : null,
    tgUserId,
  );
}

export function listActiveUsers(conn?: Database.Database): UserRow[] {
  const db = conn ?? getDb();
  return db.prepare("SELECT * FROM users WHERE is_blocked = 0").all() as UserRow[];
}
