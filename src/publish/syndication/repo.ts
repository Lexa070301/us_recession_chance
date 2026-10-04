import type Database from "better-sqlite3";
import { getDb } from "../../data/db.js";

/** syndications table — (venue, locale, digest_key) idempotence (PLAN2 §3). */
export function alreadySyndicated(
  venue: string,
  locale: string,
  digestKey: string,
  conn?: Database.Database,
): boolean {
  const db = conn ?? getDb();
  return !!db
    .prepare("SELECT 1 FROM syndications WHERE venue = ? AND locale = ? AND digest_key = ?")
    .get(venue, locale, digestKey);
}

export function markSyndicated(
  venue: string,
  locale: string,
  digestKey: string,
  url: string | null,
  conn?: Database.Database,
): void {
  const db = conn ?? getDb();
  db.prepare(
    `INSERT OR IGNORE INTO syndications (venue, locale, digest_key, url) VALUES (?, ?, ?, ?)`,
  ).run(venue, locale, digestKey, url);
}

export function getSyndicationUrl(
  venue: string,
  locale: string,
  digestKey: string,
  conn?: Database.Database,
): string | undefined {
  const db = conn ?? getDb();
  const row = db
    .prepare("SELECT url FROM syndications WHERE venue = ? AND locale = ? AND digest_key = ?")
    .get(venue, locale, digestKey) as { url: string | null } | undefined;
  return row?.url ?? undefined;
}
