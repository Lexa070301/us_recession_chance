import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bufferVenue } from "../src/publish/syndication/venues/buffer.js";
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
    await bufferVenue.publish(post);
    const { input } = gqlCall();
    expect(input.mode).toBe("shareNow");
    expect(input.needsApproval).toBe(false);
    expect(input.schedulingType).toBe("automatic");
    expect(input.channelId).toBe("ch-x");
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
    await expect(bufferVenue.publish(post)).rejects.toThrow("queue full");
  });

  it("disabled without env", () => {
    delete process.env.BUFFER_API_KEY;
    expect(bufferVenue.enabled()).toBe(false);
  });
});
