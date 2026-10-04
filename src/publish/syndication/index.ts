import type Database from "better-sqlite3";
import { getDb } from "../../data/db.js";
import { alreadySyndicated, markSyndicated } from "./repo.js";
import type { ExternalPost, Venue } from "./types.js";
import { telegraphVenue } from "./venues/telegraph.js";
import { bufferVenue } from "./venues/buffer.js";
import { blueskyVenue } from "./venues/bluesky.js";
import { mastodonVenue } from "./venues/mastodon.js";
import { discordVenue } from "./venues/discord.js";
import { redditVenue } from "./venues/reddit.js";

/**
 * Syndication fan-out (PLAN2 §3): for each (post, venue) the dedup key is
 * (venue, locale, digest_key) in `syndications`. Venues with missing env
 * config are skipped silently; a failing venue never blocks the others
 * (fail-open by design).
 */

export const venues: Venue[] = [
  telegraphVenue,
  bufferVenue,
  blueskyVenue,
  mastodonVenue,
  discordVenue,
  redditVenue,
];

export interface SyndicationResult {
  published: number;
  skipped: number;
  failed: number;
}

export async function syndicatePosts(
  posts: ExternalPost[],
  conn?: Database.Database,
  only?: string[],
): Promise<SyndicationResult> {
  const res: SyndicationResult = { published: 0, skipped: 0, failed: 0 };
  if (process.env.SYNDICATION_ENABLED !== "true") return res;

  const db = conn ?? getDb();
  for (const post of posts) {
    for (const venue of venues) {
      if (only && !only.includes(venue.key)) continue;
      if (!venue.kinds.includes(post.kind) || !venue.enabled() || !venue.handles(post)) {
        continue;
      }
      if (alreadySyndicated(venue.key, post.locale, post.key, db)) {
        res.skipped++;
        continue;
      }
      try {
        const out = await venue.publish(post);
        // Contract: venues MUST throw on failure — a resolved null means
        // "posted, no canonical URL" (e.g. Buffer returns no per-post link).
        // Returning null on a silent no-op would burn the dedup key forever.
        markSyndicated(venue.key, post.locale, post.key, out?.url ?? null, db);
        res.published++;
      } catch (err) {
        res.failed++;
        console.error(`[syndication] ${venue.key}/${post.locale} failed:`, err);
      }
    }
  }
  return res;
}
