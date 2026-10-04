import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../src/data/db.js";
import { syndicatePosts, venues } from "../src/publish/syndication/index.js";
import { alreadySyndicated, markSyndicated } from "../src/publish/syndication/repo.js";
import { clip } from "../src/publish/syndication/types.js";
import type { ExternalPost, Venue } from "../src/publish/syndication/types.js";
import { shouldSyndicate } from "../src/jobs/digest.js";

process.env.FRED_API_KEY ??= "test-key";

const post: ExternalPost = {
  key: "w:2026-W40",
  kind: "weekly",
  locale: "en",
  title: "Weekly digest",
  text: "line one\nline two",
  url: "https://example.test",
};

const fakeVenue = (over: Partial<Venue> = {}): Venue => ({
  key: "fake",
  kinds: ["weekly"],
  enabled: () => true,
  handles: () => true,
  publish: vi.fn(async () => ({ url: "https://fake/post" })),
  ...over,
});

describe("syndication", () => {
  afterEach(() => {
    venues.splice(6); // drop test venues
    delete process.env.SYNDICATION_ENABLED;
    delete process.env.SYNDICATION_LOCALES;
    vi.restoreAllMocks();
  });

  it("no-ops when SYNDICATION_ENABLED is unset", async () => {
    const db = createTestDb();
    const v = fakeVenue();
    venues.push(v);
    const res = await syndicatePosts([post], db);
    expect(res.published).toBe(0);
    expect(v.publish).not.toHaveBeenCalled();
  });

  it("publishes, records dedup row, and skips a rerun", async () => {
    process.env.SYNDICATION_ENABLED = "true";
    const db = createTestDb();
    const v = fakeVenue();
    venues.push(v);

    const first = await syndicatePosts([post], db);
    expect(first.published).toBe(1);
    expect(v.publish).toHaveBeenCalledOnce();
    expect(alreadySyndicated("fake", "en", "w:2026-W40", db)).toBe(true);

    const second = await syndicatePosts([post], db);
    expect(second.skipped).toBe(1);
    expect(v.publish).toHaveBeenCalledOnce(); // still once
  });

  it("isolates venue failures (fail-open)", async () => {
    process.env.SYNDICATION_ENABLED = "true";
    const db = createTestDb();
    const bad = fakeVenue({ key: "bad", publish: vi.fn(async () => { throw new Error("boom"); }) });
    const good = fakeVenue({ key: "good" });
    venues.push(bad, good);

    const res = await syndicatePosts([post], db);
    expect(res.failed).toBe(1);
    expect(res.published).toBe(1);
    expect(good.publish).toHaveBeenCalledOnce();
  });

  it("skips venues that are disabled or don't handle the locale/kind", async () => {
    process.env.SYNDICATION_ENABLED = "true";
    const db = createTestDb();
    const off = fakeVenue({ key: "off", enabled: () => false });
    const ruOnly = fakeVenue({ key: "ruonly", handles: (p) => p.locale === "ru" });
    const dailyOnly = fakeVenue({ key: "dailyonly", kinds: ["daily"] });
    venues.push(off, ruOnly, dailyOnly);

    const res = await syndicatePosts([post], db);
    expect(res.published).toBe(0);
    expect(off.publish).not.toHaveBeenCalled();
    expect(ruOnly.publish).not.toHaveBeenCalled();
    expect(dailyOnly.publish).not.toHaveBeenCalled();
  });

  it("all built-in venues accept event-gated daily posts", () => {
    for (const v of venues) {
      expect(v.kinds, v.key).toContain("daily");
    }
  });
});

describe("shouldSyndicate", () => {
  it("gates daily on events; weekly/self-audit always pass", () => {
    expect(shouldSyndicate("daily", 0)).toBe(false);
    expect(shouldSyndicate("daily", 2)).toBe(true);
    expect(shouldSyndicate("weekly", 0)).toBe(true);
  });
});

describe("clip", () => {
  it("truncates at word boundary", () => {
    expect(clip("hello world this is long", 12)).toBe("hello world…");
    expect(clip("supercalifragilistic text", 10)).toBe("supercali…");
    expect(clip("short", 100)).toBe("short");
  });
});

describe("markSyndicated", () => {
  it("stores urls for read-more links", () => {
    const db = createTestDb();
    markSyndicated("telegraph", "ru", "w:2026-W40", "https://telegra.ph/x", db);
    expect(alreadySyndicated("telegraph", "ru", "w:2026-W40", db)).toBe(true);
    expect(alreadySyndicated("telegraph", "en", "w:2026-W40", db)).toBe(false);
  });
});
