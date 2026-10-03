import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, setDb } from "../src/data/db.js";
import { upsertObservations } from "../src/data/repositories/observations.js";
import { getEventsSince, getSignalState } from "../src/data/repositories/signalState.js";
import { runEngine } from "../src/signals/engine.js";

// Feed a single simple signal's series: yield_10y3m below zero for >10 days
const negDays = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: `2025-01-${String(i + 1).padStart(2, "0")}`,
    value: -0.5,
  }));

describe("engine", () => {
  beforeEach(() => {
    setDb(createTestDb());
  });

  it("emits transition only once per episode (dedup)", () => {
    upsertObservations("yield_10y3m", negDays(15));
    const r1 = runEngine();
    const ev1 = r1.events.filter((e) => e.signal_key === "yield_curve_inversion");
    expect(ev1.length).toBe(1);
    expect(ev1[0].to_state).toBe("warning");
    expect(getSignalState("yield_curve_inversion").state).toBe("warning");

    // second run with no new data: skipped, no duplicate events
    const r2 = runEngine();
    expect(r2.events.length).toBe(0);
    expect(r2.skipped).toBeGreaterThan(0);
  });

  it("emits clearing transition when signal resolves", () => {
    upsertObservations("yield_10y3m", negDays(15));
    runEngine();
    upsertObservations("yield_10y3m", [
      { date: "2025-01-16", value: -0.5 },
      ...Array.from({ length: 6 }, (_, i) => ({
        date: `2025-01-${17 + i}`.padStart(10),
        value: 0.3,
      })),
    ]);
    const r = runEngine();
    const ev = r.events.find((e) => e.signal_key === "yield_curve_inversion");
    expect(ev?.to_state).toBe("ok");
  });
});
