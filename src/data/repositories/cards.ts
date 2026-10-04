import type Database from "better-sqlite3";
import { getDb } from "../db.js";

/** Digest-card dedup (photos bypass the text-only outbox). */
export function cardAlreadySent(
  digestKey: string,
  targetId: string,
  conn?: Database.Database,
): boolean {
  const db = conn ?? getDb();
  return !!db
    .prepare("SELECT 1 FROM card_sent_keys WHERE digest_key = ? AND target_id = ?")
    .get(digestKey, targetId);
}

export function markCardSent(
  digestKey: string,
  targetId: string,
  conn?: Database.Database,
): void {
  const db = conn ?? getDb();
  db.prepare(
    "INSERT OR IGNORE INTO card_sent_keys (digest_key, target_id) VALUES (?, ?)",
  ).run(digestKey, targetId);
}
