import type Database from "better-sqlite3";
import { getConfig } from "../config/load.js";
import { getDb } from "../data/db.js";

/**
 * Atom feed (PLAN2 §3): built from sent channel digests — payload_text is
 * plain/markdown-ish text, so it goes through XML escaping as-is inside a
 * <pre>-style content block.
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface FeedRow {
  digest_key: string;
  target_id: string;
  payload_text: string;
  sent_at: string;
}

export function atomFeed(
  locale: string,
  siteUrl: string,
  conn?: Database.Database,
): string {
  const db = conn ?? getDb();
  const fallback = getConfig().channels.defaults.fallback_locale;
  const pageUrl = `${siteUrl}${locale === fallback ? "" : `/${locale}`}`;
  const rows = db
    .prepare(
      `SELECT digest_key, target_id, payload_text, sent_at FROM deliveries
       WHERE target_type = 'channel' AND status = 'sent' AND locale = ?
         AND digest_key IS NOT NULL AND payload_text IS NOT NULL
       ORDER BY sent_at DESC LIMIT 30`,
    )
    .all(locale) as FeedRow[];

  const updated = rows[0]?.sent_at
    ? `${rows[0].sent_at.replace(" ", "T")}Z`
    : new Date().toISOString();
  const entries = rows
    .map((r) => {
      const title = r.payload_text.split("\n")[0].slice(0, 120);
      const ts = r.sent_at ? r.sent_at.replace(" ", "T") + "Z" : new Date().toISOString();
      const body = esc(r.payload_text);
      return `  <entry>
    <title>${esc(title)}</title>
    <id>urn:usrecessionwatch:${esc(locale)}:${esc(r.digest_key)}</id>
    <updated>${ts}</updated>
    <link href="${esc(pageUrl)}"/>
    <content type="html">&lt;pre&gt;${body}&lt;/pre&gt;</content>
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>US Recession Watch (${esc(locale)})</title>
  <id>${esc(siteUrl)}/feed-${esc(locale)}.xml</id>
  <author><name>US Recession Watch</name></author>
  <updated>${updated}</updated>
  <link href="${esc(siteUrl)}/feed-${esc(locale)}.xml" rel="self"/>
${entries}
</feed>
`;
}
