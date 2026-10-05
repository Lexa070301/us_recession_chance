import type Database from "better-sqlite3";
import { getDb } from "../db.js";

export interface DeliveryRow {
  id: number;
  event_id: number | null;
  digest_key: string | null;
  target_type: "channel" | "dm";
  target_id: string;
  locale: string;
  status: "pending" | "sending" | "sent" | "failed";
  attempts: number;
  payload_text: string | null;
  link_preview_url: string | null;
  /** Quiet-hours deferral: NULL or a UTC datetime the row waits for. */
  not_before: string | null;
  /** Claim stamp: set while a processor holds the row mid-send. */
  claimed_at: string | null;
}

/**
 * Enqueue a delivery. Returns the new row id, or 0 when a digest for this
 * (digestKey, target) already exists (dedup via uq_deliveries_digest).
 */
export function enqueueDelivery(
  d: {
    eventId?: number;
    digestKey?: string;
    targetType: "channel" | "dm";
    targetId: string;
    locale: string;
    payloadText: string;
    /** URL for Telegram's link preview (weekly digest → site og:image card). */
    linkPreviewUrl?: string;
    /** Quiet-hours deferral: hold this delivery until the given UTC datetime. */
    notBefore?: string;
  },
  conn?: Database.Database,
): number {
  const db = conn ?? getDb();
  const res = db
    .prepare(
      `INSERT INTO deliveries (event_id, digest_key, target_type, target_id, locale, payload_text, link_preview_url, not_before)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       -- target the dedup index explicitly: a bare ON CONFLICT would
       -- silently swallow ANY future constraint violation (audit L8)
       ON CONFLICT (digest_key, target_type, target_id) WHERE digest_key IS NOT NULL
       DO NOTHING`,
    )
    .run(d.eventId ?? null, d.digestKey ?? null, d.targetType, d.targetId, d.locale, d.payloadText, d.linkPreviewUrl ?? null, d.notBefore ?? null);
  return res.changes ? Number(res.lastInsertRowid) : 0;
}

/**
 * Atomically claim a queued row for sending. Returns false when another
 * processor already holds or finished it — concurrent processDeliveries
 * calls (digest job + 15-min retry cron on the same tick) can no longer
 * double-send the same row.
 */
export function claimDelivery(id: number, conn?: Database.Database): boolean {
  const db = conn ?? getDb();
  return (
    db
      .prepare(
        `UPDATE deliveries SET status = 'sending', claimed_at = datetime('now')
         WHERE id = ? AND (
           status IN ('pending', 'failed')
           -- a claim held >15 min means the holder crashed mid-send
           OR (status = 'sending' AND claimed_at <= datetime('now', '-15 minutes'))
         )`,
      )
      .run(id).changes === 1
  );
}

export function markSent(id: number, conn?: Database.Database): void {
  const db = conn ?? getDb();
  db.prepare("UPDATE deliveries SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(id);
}

export function markFailed(id: number, error: string, conn?: Database.Database): void {
  const db = conn ?? getDb();
  db.prepare(
    "UPDATE deliveries SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?",
  ).run(error.slice(0, 500), id);
}

export function pendingDeliveries(limit = 50, conn?: Database.Database): DeliveryRow[] {
  const db = conn ?? getDb();
  return db
    .prepare(
      `SELECT * FROM deliveries WHERE status = 'pending'
       AND (not_before IS NULL OR not_before <= datetime('now')) ORDER BY id LIMIT ?`,
    )
    .all(limit) as DeliveryRow[];
}

export function retryableDeliveries(maxAttempts = 5, limit = 50, conn?: Database.Database): DeliveryRow[] {
  const db = conn ?? getDb();
  return db
    .prepare(
      `SELECT * FROM deliveries WHERE
         (status = 'failed' AND attempts < ?
          -- crash mid-send: reclaim claims older than 15 min
          OR (status = 'sending' AND claimed_at <= datetime('now', '-15 minutes')))
       AND (not_before IS NULL OR not_before <= datetime('now')) ORDER BY id LIMIT ?`,
    )
    .all(maxAttempts, limit) as DeliveryRow[];
}
