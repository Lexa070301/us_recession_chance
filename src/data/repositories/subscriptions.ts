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

export interface PaymentRow {
  charge_id: string;
  user_id: number;
  stars_amount: number;
  period_days: number;
  paid_at: string;
  refund_at: string | null;
}

export function getPayment(chargeId: string, conn?: Database.Database): PaymentRow | undefined {
  const db = conn ?? getDb();
  return db.prepare("SELECT * FROM payments WHERE charge_id = ?").get(chargeId) as
    | PaymentRow
    | undefined;
}

/** Payments eligible for self-service refund: not refunded, inside the window. */
export function listRefundablePayments(
  userId: number,
  windowDays: number,
  conn?: Database.Database,
): PaymentRow[] {
  const db = conn ?? getDb();
  return db
    .prepare(
      `SELECT * FROM payments
       WHERE user_id = ? AND refund_at IS NULL
         AND paid_at >= datetime('now', ?)
       ORDER BY paid_at DESC`,
    )
    .all(userId, `-${windowDays} days`) as PaymentRow[];
}

/**
 * Refund bookkeeping: marks the payment refunded and shortens the active
 * subscription by the payment's period (each payment bought period_days).
 * Cancels the plan when no paid time remains. Atomic.
 */
export function applyRefund(
  chargeId: string,
  conn?: Database.Database,
): { expiresAt: string | null } | "already_refunded" | "unknown" {
  const db = conn ?? getDb();
  return db.transaction(() => {
    const marked = db
      .prepare(
        `UPDATE payments SET refund_at = datetime('now')
         WHERE charge_id = ? AND refund_at IS NULL`,
      )
      .run(chargeId);
    if (marked.changes === 0) {
      return db.prepare("SELECT 1 AS x FROM payments WHERE charge_id = ?").get(chargeId)
        ? ("already_refunded" as const)
        : ("unknown" as const);
    }
    const pay = db
      .prepare("SELECT user_id, period_days FROM payments WHERE charge_id = ?")
      .get(chargeId) as { user_id: number; period_days: number };
    const sub = db
      .prepare("SELECT 1 AS x FROM subscriptions WHERE user_id = ? AND status = 'active'")
      .get(pay.user_id);
    if (!sub) return { expiresAt: null };

    db.prepare("UPDATE subscriptions SET expires_at = datetime(expires_at, ?) WHERE user_id = ?").run(
      `-${pay.period_days} days`,
      pay.user_id,
    );
    const row = db
      .prepare(
        "SELECT expires_at, expires_at <= datetime('now') AS due FROM subscriptions WHERE user_id = ?",
      )
      .get(pay.user_id) as { expires_at: string; due: number };
    if (row.due) {
      db.prepare("UPDATE subscriptions SET status = 'canceled' WHERE user_id = ?").run(pay.user_id);
      setUserPlan(pay.user_id, "free", db);
      return { expiresAt: null };
    }
    return { expiresAt: row.expires_at };
  })();
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
