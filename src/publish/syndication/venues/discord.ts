import {
  clip,
  postJson,
  syndicationLocales,
  type ExternalPost,
  type PublishResult,
  type Venue,
} from "../types.js";

/**
 * Discord (PLAN2 §3.5): webhook POST {content}. Text ≤2000 chars; daily
 * supported (channel is ours — volume is fine).
 */

const LIMIT = 2000;

export const discordVenue: Venue = {
  key: "discord",
  kinds: ["daily", "weekly", "self_audit"],
  enabled() {
    return !!process.env.DISCORD_WEBHOOK_URL;
  },
  handles(post) {
    return syndicationLocales().includes(post.locale);
  },
  async publish(post: ExternalPost): Promise<PublishResult | null> {
    let text = clip(post.text, LIMIT - (post.url ? post.url.length + 2 : 0));
    if (post.url && !text.includes(post.url)) text = `${text}\n${post.url}`;
    await postJson(process.env.DISCORD_WEBHOOK_URL!, { content: clip(text, LIMIT) });
    return null;
  },
};
