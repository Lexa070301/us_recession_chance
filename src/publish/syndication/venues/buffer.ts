import {
  clip,
  postJson,
  syndicationLocales,
  type ExternalPost,
  type PublishResult,
  type Venue,
} from "../types.js";
import type Database from "better-sqlite3";
import { alreadySyndicated, markSyndicated } from "../repo.js";

/**
 * Buffer (PLAN2 §3.6): one venue multiplexing X + Threads + LinkedIn via the
 * new GraphQL API (legacy REST API sunsets 2027-02-01). Free tier: 3 channels,
 * 250 req/24h — we make at most 3 calls per digest. Daily is event-gated
 * upstream (digest.ts); weekly + self-audit always.
 *
 * Channel IDs come from the Buffer dashboard (env per network).
 * `createPost` requires `mode` (ShareMode) + `needsApproval` and returns a
 * union — MutationError must be checked or silent failures get marked as
 * published (audit H1).
 */

const ENDPOINT = "https://api.buffer.com";

const CHANNEL_LIMITS: Record<string, number> = {
  x: 280,
  threads: 500,
  linkedin: 4000,
};

function channels(): { network: string; id: string; limit: number }[] {
  const envs: [string, string | undefined][] = [
    ["x", process.env.BUFFER_CHANNEL_X],
    ["threads", process.env.BUFFER_CHANNEL_THREADS],
    ["linkedin", process.env.BUFFER_CHANNEL_LINKEDIN],
  ];
  return envs
    .filter((e): e is [string, string] => !!e[1])
    .map(([network, id]) => ({ network, id, limit: CHANNEL_LIMITS[network] }));
}

interface CreatePostResponse {
  data?: {
    createPost?:
      | { __typename: "PostActionSuccess"; post?: { id: string } }
      | { __typename: "MutationError"; message?: string };
  };
  errors?: { message: string }[];
}

async function createPost(apiKey: string, channelId: string, text: string): Promise<string | undefined> {
  const res = (await postJson(
    ENDPOINT,
    {
      query: `mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          __typename
          ... on PostActionSuccess { post { id } }
          ... on MutationError { message }
        }
      }`,
      variables: {
        input: {
          channelId,
          text,
          schedulingType: "automatic",
          mode: "shareNow",
          needsApproval: false,
        },
      },
    },
    { authorization: `Bearer ${apiKey}` },
  )) as CreatePostResponse;
  if (res.errors?.length) throw new Error(`buffer: ${res.errors[0].message}`);
  const out = res.data?.createPost;
  if (!out) throw new Error("buffer: empty createPost result");
  if (out.__typename === "MutationError") {
    throw new Error(`buffer: ${out.message ?? "MutationError"}`);
  }
  return out.post?.id;
}

export const bufferVenue: Venue = {
  key: "buffer",
  kinds: ["daily", "weekly", "self_audit", "fact"],
  enabled() {
    return !!(process.env.BUFFER_API_KEY && channels().length);
  },
  handles(post) {
    return syndicationLocales().includes(post.locale);
  },
  async publish(post: ExternalPost, conn?: Database.Database): Promise<PublishResult | null> {
    const apiKey = process.env.BUFFER_API_KEY!;
    const failures: Error[] = [];
    for (const ch of channels()) {
      // Per-network dedup (audit F4): a failure in one network must not
      // cause already-published networks to repost on retry.
      const venueKey = `buffer:${ch.network}`;
      if (alreadySyndicated(venueKey, post.locale, post.key, conn)) continue;
      // X gets the tightest cut; LinkedIn gets near-full text.
      const base =
        ch.network === "x"
          ? (post.variants?.short ?? post.text)
          : ch.network === "threads"
            ? (post.variants?.medium ?? post.variants?.short ?? post.text)
            : post.text;
      let text = clip(base, ch.limit - (post.url ? post.url.length + 2 : 0));
      if (post.url && !text.includes(post.url)) text = `${text}\n${post.url}`;
      try {
        await createPost(apiKey, ch.id, clip(text, ch.limit));
        markSyndicated(venueKey, post.locale, post.key, null, conn);
      } catch (err) {
        failures.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (failures.length) {
      throw new Error(failures.map((e) => e.message).join("; "));
    }
    return null;
  },
};
