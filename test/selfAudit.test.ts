import { describe, it, expect } from "vitest";
import { classifyEpisodes } from "../src/backtest/stats.js";
import { listEpisodes, upsertEpisode } from "../src/data/repositories/episodes.js";
import { createTestDb } from "../src/data/db.js";
import type { RecessionPeriod } from "../src/data/nber.js";

process.env.FRED_API_KEY ??= "test-key";

const recessions: RecessionPeriod[] = [
  { start: "2008-01", end: "2009-06" },
  { start: "2020-03", end: "2020-04" },
];

describe("classifyEpisodes", () => {
  it("hit: recession starts within 12m of onset", () => {
    const eps = [{ start: "2007-06-01", end: "2008-12-01", peak: "warning" as const }];
    const out = classifyEpisodes(eps, recessions, "2026-01");
    expect(out[0].outcome).toBe("hit");
  });

  it("fp: window closed with no recession", () => {
    const eps = [{ start: "2015-01-01", end: "2015-06-01", peak: "warning" as const }];
    expect(classifyEpisodes(eps, recessions, "2026-01")[0].outcome).toBe("fp");
  });

  it("pending: outcome window still open", () => {
    const eps = [{ start: "2025-08-01", end: null, peak: "watch" as const }];
    // usrec last = 2026-01 → knowable while onset <= 2025-01; 2025-08 is open
    expect(classifyEpisodes(eps, recessions, "2026-01")[0].outcome).toBe("pending");
  });

  it("nowcast hit: episode onset within −3/+6m of a recession start", () => {
    const eps = [{ start: "2020-05-01", end: "2020-08-01", peak: "critical" as const }];
    expect(classifyEpisodes(eps, recessions, "2026-01", true)[0].outcome).toBe("hit");
    const far = [{ start: "2021-01-01", end: "2021-03-01", peak: "critical" as const }];
    expect(classifyEpisodes(far, recessions, "2026-01", true)[0].outcome).toBe("fp");
  });
});

describe("episodes repo", () => {
  it("upserts and lists episodes; pending rows update outcome", () => {
    const db = createTestDb();
    upsertEpisode({ signalKey: "sahm", start: "2025-01-01", end: null, peak: "watch", outcome: "pending" }, db);
    upsertEpisode({ signalKey: "sahm", start: "2025-01-01", end: "2025-04-01", peak: "warning", outcome: "fp" }, db);
    upsertEpisode({ signalKey: "yc", start: "2019-03-01", end: "2020-03-01", peak: "critical", outcome: "hit" }, db);
    const all = listEpisodes(undefined, db);
    expect(all).toHaveLength(2);
    const sahm = listEpisodes("sahm", db);
    expect(sahm[0].outcome).toBe("fp");
    expect(sahm[0].end).toBe("2025-04-01");
  });
});
