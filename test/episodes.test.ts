import { describe, it, expect } from "vitest";
import { parseEpisodesArgs, renderEpisodes, _episodesCache } from "../src/bot/episodes.js";
import { createTestDb } from "../src/data/db.js";
import { upsertObservations } from "../src/data/repositories/observations.js";

process.env.FRED_API_KEY ??= "test-key";

describe("parseEpisodesArgs", () => {
  it("parses year, range and asof flag", () => {
    expect(parseEpisodesArgs("2008")).toEqual({ from: 2008, to: 2008, asof: false });
    expect(parseEpisodesArgs("2007-2009")).toEqual({ from: 2007, to: 2009, asof: false });
    expect(parseEpisodesArgs("2008 asof")).toEqual({ from: 2008, to: 2008, asof: true });
    expect(parseEpisodesArgs("2007–2009 asof")).toEqual({ from: 2007, to: 2009, asof: true });
  });
  it("rejects garbage and impossible ranges", () => {
    expect(parseEpisodesArgs("")).toBeNull();
    expect(parseEpisodesArgs("abc")).toBeNull();
    expect(parseEpisodesArgs("2009-2007")).toBeNull();
    expect(parseEpisodesArgs("1900")).toBeNull();
    expect(parseEpisodesArgs("3000")).toBeNull();
  });
});

describe("renderEpisodes", () => {
  it("renders on an empty db and caches by year|mode|locale", () => {
    const db = createTestDb();
    _episodesCache.clear();
    const text = renderEpisodes({ from: 2008, to: 2008, asof: false }, "en", db);
    expect(text).toContain("Episodes 2008");
    expect(text).toContain("latest-revision");
    expect(_episodesCache.has("2008-2008|latest|en")).toBe(true);
    expect(_episodesCache.has("2008-2008|asof|en")).toBe(false);
  });

  it("reports signal episodes overlapping the window + NBER periods", () => {
    const db = createTestDb();
    // synthetic series: threshold signal fires 2008
    upsertObservations(
      "yield_10y3m",
      [{ date: "2008-06-01", value: -1 }, { date: "2009-01-01", value: 1 }],
      "",
      db,
    );
    upsertObservations(
      "usrec",
      [
        { date: "2008-01-01", value: 1 },
        { date: "2008-02-01", value: 1 },
        { date: "2008-06-01", value: 0 },
      ],
      "",
      db,
    );
    _episodesCache.clear();
    const text = renderEpisodes({ from: 2008, to: 2008, asof: false }, "en", db);
    expect(text).toContain("NBER recession 2008-01–2008-02");
  });
});
