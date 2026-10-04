import { postJson, type ExternalPost, type PublishResult, type Venue } from "../types.js";

/**
 * Telegraph (PLAN2 §3.4): one page per locale — TELEGRAPH_TOKEN_EN / _RU.
 * The page URL is stored in syndications.url and reused as "read more".
 */

interface TelegraphResponse {
  ok: boolean;
  result?: { url: string; path: string };
  error?: string;
}

function tokenFor(locale: string): string | undefined {
  return process.env[`TELEGRAPH_TOKEN_${locale.toUpperCase()}`];
}

/** Digest text → Telegraph node array (one paragraph per line). */
function toNodes(text: string): unknown[] {
  return text
    .split("\n")
    .map((line) => (line.trim() ? { tag: "p", children: [line] } : { tag: "br" }));
}

export const telegraphVenue: Venue = {
  key: "telegraph",
  kinds: ["weekly", "self_audit"],
  enabled() {
    return !!(process.env.TELEGRAPH_TOKEN_EN || process.env.TELEGRAPH_TOKEN_RU);
  },
  handles(post) {
    return !!tokenFor(post.locale);
  },
  async publish(post: ExternalPost): Promise<PublishResult | null> {
    const res = (await postJson("https://api.telegra.ph/createPage", {
      access_token: tokenFor(post.locale),
      title: post.title.replace(/^[^\w]*\s*/, "").slice(0, 256),
      author_name: "US Recession Watch",
      content: toNodes(post.text),
      return_content: false,
    })) as TelegraphResponse;
    if (!res.ok || !res.result) throw new Error(`telegraph: ${res.error ?? "no result"}`);
    return { url: res.result.url };
  },
};
