import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bufferVenue } from "../src/publish/syndication/venues/buffer.js";
import { alreadySyndicated } from "../src/publish/syndication/repo.js";
import { createTestDb } from "../src/data/db.js";
import type { ExternalPost } from "../src/publish/syndication/types.js";

const post: ExternalPost = {
  key: "w:2026-W40",
  kind: "weekly",
  locale: "en",
  title: "Weekly digest",
  text: "score 7.2 — elevated\nhttps://example.com",
  url: "https://example.com",
};

function gqlCall(): { input: Record<string, unknown> } {
  const body = JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
  return body.variables;
}

describe("bufferVenue", () => {
  beforeEach(() => {
    process.env.BUFFER_API_KEY = "k";
    process.env.BUFFER_CHANNEL_X = "ch-x";
    delete process.env.BUFFER_CHANNEL_THREADS;
    delete process.env.BUFFER_CHANNEL_LINKEDIN;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BUFFER_API_KEY;
    delete process.env.BUFFER_CHANNEL_X;
  });

  it("sends required mode + needsApproval in CreatePostInput", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { createPost: { __typename: "PostActionSuccess", post: { id: "p1" } } } }),
          { status: 200 },
        ),
      ),
    );
    const db = createTestDb();
    await bufferVenue.publish(post, db);
    const { input } = gqlCall();
    expect(input.mode).toBe("shareNow");
    expect(input.needsApproval).toBe(false);
    expect(input.schedulingType).toBe("automatic");
    expect(input.channelId).toBe("ch-x");
    // success recorded under a per-network key
    expect(alreadySyndicated("buffer:x", post.locale, post.key, db)).toBe(true);
  });

  it("throws on MutationError instead of silently marking published", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { createPost: { __typename: "MutationError", message: "queue full" } } }),
          { status: 200 },
        ),
      ),
    );
    await expect(bufferVenue.publish(post, createTestDb())).rejects.toThrow("queue full");
  });

  it("partial network failure does not repost succeeded networks on retry (F4)", async () => {
    const db = createTestDb();
    process.env.BUFFER_CHANNEL_LINKEDIN = "ch-li";
    try {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls++;
          // first call (X) succeeds, second (LinkedIn) fails
          return calls === 1
            ? new Response(
                JSON.stringify({ data: { createPost: { __typename: "PostActionSuccess", post: { id: "p1" } } } }),
                { status: 200 },
              )
            : new Response(
                JSON.stringify({ data: { createPost: { __typename: "MutationError", message: "li down" } } }),
                { status: 200 },
              );
        }),
      );
      await expect(bufferVenue.publish(post, db)).rejects.toThrow("li down");
      expect(alreadySyndicated("buffer:x", post.locale, post.key, db)).toBe(true);
      expect(alreadySyndicated("buffer:linkedin", post.locale, post.key, db)).toBe(false);

      // retry: X must not be reposted — only LinkedIn is attempted
      calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls++;
          return new Response(
            JSON.stringify({ data: { createPost: { __typename: "PostActionSuccess", post: { id: "p2" } } } }),
            { status: 200 },
          );
        }),
      );
      await bufferVenue.publish(post, db);
      expect(calls).toBe(1); // LinkedIn only — X deduped
      expect(alreadySyndicated("buffer:linkedin", post.locale, post.key, db)).toBe(true);
    } finally {
      delete process.env.BUFFER_CHANNEL_LINKEDIN;
    }
  });

  it("disabled without env", () => {
    delete process.env.BUFFER_API_KEY;
    expect(bufferVenue.enabled()).toBe(false);
  });
});

describe("postJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null on 204 No Content instead of throwing (F1)", async () => {
    const { postJson } = await import("../src/publish/syndication/types.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(postJson("https://x.test/hook", { a: 1 })).resolves.toBeNull();
  });

  it("returns null on 200 with empty body", async () => {
    const { postJson } = await import("../src/publish/syndication/types.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    await expect(postJson("https://x.test/hook", { a: 1 })).resolves.toBeNull();
  });

  it("parses JSON bodies and throws on non-ok status", async () => {
    const { postJson } = await import("../src/publish/syndication/types.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })),
    );
    await expect(postJson("https://x.test/hook", {})).resolves.toEqual({ ok: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    await expect(postJson("https://x.test/hook", {})).rejects.toThrow("500");
  });
});
