import type Database from "better-sqlite3";
import { getDb } from "../db.js";

export interface DeliveryRow {
  id: number;
  event_id: number | null;
  digest_key: string | null;
  target_type: "channel" | "dm";
  target_id: string;
  locale: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  payload_text: string | null;
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
  },
  conn?: Database.Database,
): number {
  const db = conn ?? getDb();
  const res = db
    .prepare(
      `INSERT INTO deliveries (event_id, digest_key, target_type, target_id, locale, payload_text)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(d.eventId ?? null, d.digestKey ?? null, d.targetType, d.targetId, d.locale, d.payloadText);
  return res.changes ? Number(res.lastInsertRowid) : 0;
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
    .prepare("SELECT * FROM deliveries WHERE status = 'pending' ORDER BY id LIMIT ?")
    .all(limit) as DeliveryRow[];
}

export function retryableDeliveries(maxAttempts = 5, limit = 50, conn?: Database.Database): DeliveryRow[] {
  const db = conn ?? getDb();
  return db
    .prepare(
      "SELECT * FROM deliveries WHERE status = 'failed' AND attempts < ? ORDER BY id LIMIT ?",
    )
    .all(maxAttempts, limit) as DeliveryRow[];
}
