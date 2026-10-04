import {
  clip,
  postJson,
  syndicationLocales,
  type ExternalPost,
  type PublishResult,
  type Venue,
} from "../types.js";

/**
 * Bluesky (PLAN2 §3.5): AT Protocol — createSession then createRecord.
 * Daily (event-gated in digest.ts) + weekly + self-audit; ≤300 chars
 * with link facets.
 */

const LIMIT = 300;

interface Session {
  accessJwt: string;
  did: string;
}

async function createSession(handle: string, appPassword: string): Promise<Session> {
  const res = (await postJson("https://bsky.social/xrpc/com.atproto.server.createSession", {
    identifier: handle,
    password: appPassword,
  })) as Session;
  return res;
}

/** Link facet: byte-offset range for the URL so Bluesky renders it clickable. */
function linkFacets(text: string): unknown[] {
  const facets: unknown[] = [];
  for (const m of text.matchAll(/https?:\/\/\S+/g)) {
    const start = Buffer.byteLength(text.slice(0, m.index), "utf8");
    facets.push({
      index: { byteStart: start, byteEnd: start + Buffer.byteLength(m[0], "utf8") },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    });
  }
  return facets;
}

export const blueskyVenue: Venue = {
  key: "bluesky",
  kinds: ["daily", "weekly", "self_audit"],
  enabled() {
    return !!(process.env.BSKY_HANDLE && process.env.BSKY_APP_PASSWORD);
  },
  handles(post) {
    return syndicationLocales().includes(post.locale);
  },
  async publish(post: ExternalPost): Promise<PublishResult | null> {
    const session = await createSession(process.env.BSKY_HANDLE!, process.env.BSKY_APP_PASSWORD!);
    const body = post.variants?.short ?? post.text;
    let text = clip(body, LIMIT - (post.url ? post.url.length + 2 : 0));
    if (post.url && !text.includes(post.url)) text = `${text}\n${post.url}`;
    text = clip(text, LIMIT);
    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text,
      createdAt: new Date().toISOString(),
      langs: [post.locale],
    };
    const facets = linkFacets(text);
    if (facets.length) record.facets = facets;
    await postJson(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      { repo: session.did, collection: "app.bsky.feed.post", record },
      { authorization: `Bearer ${session.accessJwt}` },
    );
    return null; // createRecord returns uri/cid; web URL isn't derivable without handle resolution
  },
};
