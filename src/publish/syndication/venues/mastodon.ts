import {
  clip,
  postJson,
  syndicationLocales,
  type ExternalPost,
  type PublishResult,
  type Venue,
} from "../types.js";

/**
 * Mastodon (PLAN2 §3.5): POST {instance}/api/v1/statuses, Bearer token,
 * ~500 chars. Daily (event-gated in digest.ts) + weekly + self-audit.
 */

const LIMIT = 500;

export const mastodonVenue: Venue = {
  key: "mastodon",
  kinds: ["daily", "weekly", "self_audit", "fact"],
  enabled() {
    return !!(process.env.MASTODON_INSTANCE && process.env.MASTODON_TOKEN);
  },
  handles(post) {
    return syndicationLocales().includes(post.locale);
  },
  async publish(post: ExternalPost): Promise<PublishResult | null> {
    const instance = process.env.MASTODON_INSTANCE!.replace(/\/$/, "");
    let text = clip(post.variants?.medium ?? post.text, LIMIT - (post.url ? post.url.length + 2 : 0));
    if (post.url && !text.includes(post.url)) text = `${text}\n${post.url}`;
    const res = (await postJson(
      `${instance}/api/v1/statuses`,
      { status: clip(text, LIMIT), visibility: "public" },
      { authorization: `Bearer ${process.env.MASTODON_TOKEN}` },
    )) as { url?: string };
    return res.url ? { url: res.url } : null;
  },
};
