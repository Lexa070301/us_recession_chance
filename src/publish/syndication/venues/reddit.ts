import {
  clip,
  postJson,
  syndicationLocales,
  type ExternalPost,
  type PublishResult,
  type Venue,
} from "../types.js";

/**
 * Reddit (PLAN2 §3.8): own subreddit only (REDDIT_SUBREDDIT=USRecessionWatch).
 * Script-app password grant → oauth.reddit.com/api/submit. Always a self-post:
 * a bare link drops the whole digest body — the text carries the content and
 * the canonical URL rides at the bottom (audit M6). Weekly + self-audit.
 */

const UA = "us-recession-watch/0.1 (by u/USRecessionWatch)";

async function redditToken(): Promise<string> {
  const auth = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": UA,
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: process.env.REDDIT_USERNAME!,
      password: process.env.REDDIT_PASSWORD!,
    }),
  });
  if (!res.ok) throw new Error(`reddit token → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("reddit token: no access_token");
  return json.access_token;
}

export const redditVenue: Venue = {
  key: "reddit",
  kinds: ["weekly", "self_audit"],
  enabled() {
    return !!(
      process.env.REDDIT_CLIENT_ID &&
      process.env.REDDIT_CLIENT_SECRET &&
      process.env.REDDIT_USERNAME &&
      process.env.REDDIT_PASSWORD &&
      process.env.REDDIT_SUBREDDIT
    );
  },
  handles(post) {
    return syndicationLocales().includes(post.locale);
  },
  async publish(post: ExternalPost): Promise<PublishResult | null> {
    const token = await redditToken();
    const sr = process.env.REDDIT_SUBREDDIT!;
    const title = clip(post.title.replace(/^[^\w]*\s*/, ""), 300);
    const body = post.url ? `${post.text}\n\n${post.url}` : post.text;
    const form = new URLSearchParams({
      sr,
      title,
      kind: "self",
      api_type: "json",
      text: clip(body, 10000),
    });

    const res = await fetch("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": UA,
      },
      body: form,
    });
    if (!res.ok) throw new Error(`reddit submit → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { json?: { errors?: unknown[]; data?: { url?: string } } };
    if (json.json?.errors?.length) {
      throw new Error(`reddit submit errors: ${JSON.stringify(json.json.errors).slice(0, 300)}`);
    }
    return json.json?.data?.url ? { url: json.json.data.url } : null;
  },
};
