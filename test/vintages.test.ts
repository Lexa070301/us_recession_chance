import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb, setDb } from "../src/data/db.js";
import {
  getVintageDates,
  latestVintageAt,
  observationsAsOf,
  upsertObservations,
} from "../src/data/repositories/observations.js";
import { FredClient } from "../src/data/fredClient.js";
import { replaySignalAsof, VintageSeriesCache } from "../src/backtest/replay.js";
import type { SignalDef } from "../src/config/schema.js";

process.env.FRED_API_KEY ??= "test-key";

describe("observationsAsOf", () => {
  it("selects the latest vintage on/before asOfDate (revisions apply forward)", () => {
    const db = createTestDb();
    upsertObservations(
      "unrate",
      [
        { date: "2000-01-01", value: 4.0 },
        { date: "2000-02-01", value: 4.1 },
      ],
      "2000-03-01",
      db,
    );
    // later vintage: 2000-01 revised 4.0 -> 4.2, new obs 2000-03
    upsertObservations(
      "unrate",
      [
        { date: "2000-01-01", value: 4.2 },
        { date: "2000-02-01", value: 4.1 },
        { date: "2000-03-01", value: 4.4 },
      ],
      "2000-06-01",
      db,
    );

    expect(observationsAsOf("unrate", "2000-04-01", {}, db)).toEqual([
      { date: "2000-01-01", value: 4.0 },
      { date: "2000-02-01", value: 4.1 },
    ]);
    expect(observationsAsOf("unrate", "2000-07-01", {}, db)[0].value).toBe(4.2);
    expect(latestVintageAt("unrate", "2000-05-31", db)).toBe("2000-03-01");
  });

  it("returns [] when no vintage exists on/before asOfDate — never falls back to latest revision", () => {
    const db = createTestDb();
    upsertObservations("unrate", [{ date: "2000-01-01", value: 4.0 }], "2000-03-01", db);
    // latest-revision row exists but must NOT leak into an early as-of query
    upsertObservations("unrate", [{ date: "2000-01-01", value: 9.9 }], "", db);
    expect(observationsAsOf("unrate", "2000-01-01", {}, db)).toEqual([]);
    expect(observationsAsOf("unrate", "1999-12-31", {}, db)).toEqual([]);
  });
});

describe("VintageSeriesCache", () => {
  it("resolves vintage-free series to the latest revision", () => {
    const db = createTestDb();
    upsertObservations("yield_10y3m", [{ date: "2000-01-01", value: -0.5 }], "", db);
    const cache = new VintageSeriesCache(db);
    expect(cache.vintageAt("yield_10y3m", "2000-02-01")).toBe("");
    expect(cache.get({ key: "yield_10y3m", transform: "value" }, "2000-02-01").obs).toHaveLength(1);
  });

  it("hides observations that only exist in later vintages (no look-ahead)", () => {
    const db = createTestDb();
    // vintage 2000-03: history ends 2000-02; vintage 2000-06 adds 2000-03..05
    upsertObservations(
      "unrate",
      [
        { date: "2000-01-01", value: 4.0 },
        { date: "2000-02-01", value: 4.1 },
      ],
      "2000-03-01",
      db,
    );
    upsertObservations(
      "unrate",
      [
        { date: "2000-01-01", value: 4.0 },
        { date: "2000-02-01", value: 4.1 },
        { date: "2000-03-01", value: 4.4 },
        { date: "2000-04-01", value: 4.5 },
        { date: "2000-05-01", value: 4.6 },
      ],
      "2000-06-01",
      db,
    );
    const cache = new VintageSeriesCache(db);
    expect(cache.get({ key: "unrate", transform: "value" }, "2000-04-15").obs).toHaveLength(2);
    expect(cache.get({ key: "unrate", transform: "value" }, "2000-07-01").obs).toHaveLength(5);
    // before the first stored vintage: nothing was knowable
    expect(cache.get({ key: "unrate", transform: "value" }, "2000-02-01").obs).toEqual([]);
  });
});

describe("replaySignalAsof", () => {
  it("fires only after the revision that crosses the threshold becomes knowable", () => {
    const db = createTestDb();
    // Latest revision (grid source): unrate = 8 for all three months.
    upsertObservations(
      "unrate",
      [
        { date: "2000-01-01", value: 8 },
        { date: "2000-02-01", value: 8 },
        { date: "2000-03-01", value: 8 },
      ],
      "",
      db,
    );
    // As known in Feb: Jan was really 4 (below threshold).
    upsertObservations("unrate", [{ date: "2000-01-01", value: 4 }], "2000-02-15", db);
    // June vintage: history revised up to 8.
    upsertObservations(
      "unrate",
      [
        { date: "2000-01-01", value: 8 },
        { date: "2000-02-01", value: 8 },
        { date: "2000-03-01", value: 8 },
      ],
      "2000-06-01",
      db,
    );

    const signal: SignalDef = {
      key: "test_unrate",
      block: "labor",
      weight: 1,
      input: { key: "unrate", transform: "value" },
      evaluator: {
        type: "levels",
        params: { levels: [{ state: "warning", op: ">", threshold: 7 }] },
      },
    };

    // Grid eval dates: obs + 45d lag -> ~Feb 15, ~Mar 15, ~Apr 15.
    const states = replaySignalAsof(signal, new VintageSeriesCache(db));
    expect(states).toHaveLength(3);
    // eval ~2000-02-15: vintage 2000-02-15 shows 4 -> ok (no look-ahead to revised 8)
    expect(states[0].state).toBe("ok");
    // eval ~2000-03-15 and ~2000-04-15: still only the pre-revision vintage
    expect(states[1].state).toBe("ok");
    expect(states[2].state).toBe("ok");
  });
});

describe("FredClient.fetchVintageBatch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("groups response rows by realtime_start into separate vintages", async () => {
    setDb(createTestDb());
    const payload = {
      observations: [
        { realtime_start: "2000-03-01", realtime_end: "2000-05-31", date: "2000-01-01", value: "4.0" },
        { realtime_start: "2000-03-01", realtime_end: "2000-05-31", date: "2000-02-01", value: "4.1" },
        { realtime_start: "2000-06-01", realtime_end: "2000-08-31", date: "2000-01-01", value: "4.2" },
        { realtime_start: "2000-06-01", realtime_end: "2000-08-31", date: "2000-03-01", value: "." },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );

    const client = new FredClient();
    const res = await client.fetchVintageBatch("unrate", ["2000-03-01", "2000-06-01"]);
    // The "." value row is filtered out -> vintage 2000-06 has a single obs.
    expect(res).toEqual([
      { vintage: "2000-03-01", rows: 2 },
      { vintage: "2000-06-01", rows: 1 },
    ]);
    expect(getVintageDates("unrate")).toEqual(["2000-03-01", "2000-06-01"]);
    expect(observationsAsOf("unrate", "2000-04-01")).toHaveLength(2);
    // Delta model: 2000-01 was revised to 4.2 in the June vintage; 2000-02
    // carries forward its last stated value (4.1 from the March vintage).
    expect(observationsAsOf("unrate", "2000-07-01")).toEqual([
      { date: "2000-01-01", value: 4.2 },
      { date: "2000-02-01", value: 4.1 },
    ]);
  });
});
