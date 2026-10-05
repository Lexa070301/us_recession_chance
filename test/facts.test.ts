import { describe, expect, it } from "vitest";
import { createTestDb } from "../src/data/db.js";
import { markSyndicated } from "../src/publish/syndication/repo.js";
import { buildFactPost, collectFacts, nextFact } from "../src/jobs/facts.js";

process.env.FRED_API_KEY ??= "test-key";

describe("facts", () => {
  it("collects glossary + episode facts in both locales", () => {
    const en = collectFacts("en");
    const ru = collectFacts("ru");
    expect(en.length).toBeGreaterThan(40);
    expect(ru.length).toBeGreaterThan(40);
    // Glossary facts come first, episode facts last — canonical order.
    expect(en[0].id).toMatch(/^g:/);
    expect(en.at(-1)!.id).toMatch(/^e:/);
    for (const f of [...en, ...ru]) {
      expect(f.text.length).toBeGreaterThan(20);
      expect(f.text).not.toContain("**");
      expect(f.path).toMatch(/^\/(glossary|episodes)\//);
      expect(f.name.length).toBeGreaterThan(3);
    }
  });

  it("rotates to the next unconsumed fact", () => {
    const db = createTestDb();
    const first = nextFact("en", db)!;
    expect(first).not.toBeNull();
    markSyndicated("fact", "en", `f:${first.id}`, null, db);
    const second = nextFact("en", db)!;
    expect(second.id).not.toBe(first.id);
    // Other locales are unaffected.
    expect(nextFact("ru", db)!.id).toBe(first.id);
  });

  it("builds a post with stable key, canonical url and clipped variants", () => {
    const fact = collectFacts("en")[0];
    process.env.SITE_URL = "https://example.test";
    const post = buildFactPost(fact, "en");
    expect(post.key).toBe(`f:${fact.id}`);
    expect(post.kind).toBe("fact");
    expect(post.url).toBe(`https://example.test${fact.path}`);
    expect(post.text).toContain(fact.text);
    expect(post.variants!.short!.length).toBeLessThanOrEqual(240);

    const ru = buildFactPost(fact, "ru");
    expect(ru.url).toBe(`https://example.test/ru${fact.path}`);
    delete process.env.SITE_URL;
    const bare = buildFactPost(fact, "en");
    expect(bare.url).toBeUndefined();
  });
});
