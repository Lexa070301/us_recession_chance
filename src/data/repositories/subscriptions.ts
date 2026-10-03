import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { setUserPlan } from "./users.js";

export function recordPayment(
  chargeId: string,
  userId: number,
  starsAmount: number,
  periodDays: number,
  conn?: Database.Database,
): void {
  const db = conn ?? getDb();
  db.prepare(
    `INSERT INTO payments (charge_id, user_id, stars_amount, period_days)
     VALUES (?, ?, ?, ?)`,
  ).run(chargeId, userId, starsAmount, periodDays);
}

export function activateSubscription(
  userId: number,
  periodDays: number,
  chargeId: string,
  conn?: Database.Database,
): void {
  const db = conn ?? getDb();
  // extend from current expiry if still active, else from now
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO subscriptions (user_id, status, started_at, expires_at, charge_id_last)
       VALUES (?, 'active', datetime('now'), datetime('now', ?), ?)
       ON CONFLICT (user_id) DO UPDATE SET
         status = 'active',
         expires_at = datetime(
           MAX(COALESCE(subscriptions.expires_at, datetime('now')), datetime('now')),
           ?
         ),
         charge_id_last = excluded.charge_id_last`,
    ).run(userId, `+${periodDays} days`, chargeId, `+${periodDays} days`);
    setUserPlan(userId, "plus", db);
  });
  tx();
}

export function getSubscription(
  userId: number,
  conn?: Database.Database,
): { status: string; expires_at: string | null } | undefined {
  const db = conn ?? getDb();
  return db
    .prepare("SELECT status, expires_at FROM subscriptions WHERE user_id = ?")
    .get(userId) as { status: string; expires_at: string | null } | undefined;
}

export function isSubscriptionActive(userId: number, conn?: Database.Database): boolean {
  const db = conn ?? getDb();
  const row = db
    .prepare(
      `SELECT status, expires_at FROM subscriptions
       WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now')`,
    )
    .get(userId);
  return Boolean(row);
}

/** Expire overdue subscriptions and downgrade plans. Returns expired user ids. */
export function expireDueSubscriptions(conn?: Database.Database): number[] {
  const db = conn ?? getDb();
  const due = db
    .prepare(
      `SELECT user_id FROM subscriptions
       WHERE status = 'active' AND expires_at <= datetime('now')`,
    )
    .all() as { user_id: number }[];
  const tx = db.transaction(() => {
    for (const { user_id } of due) {
      db.prepare("UPDATE subscriptions SET status = 'expired' WHERE user_id = ?").run(user_id);
      setUserPlan(user_id, "free", db);
    }
  });
  tx();
  return due.map((r) => r.user_id);
}
