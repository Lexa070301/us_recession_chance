import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, getDb, setDb } from "../src/data/db.js";
import { pendingDeliveries } from "../src/data/repositories/deliveries.js";
import type { SignalEventRow, SignalState } from "../src/data/repositories/signalState.js";
import { savePrefs, setUserPlan, upsertUser } from "../src/data/repositories/users.js";
import { routeCompositeAlerts, routeEvent } from "../src/publish/publisher.js";
import type { CompositeResult } from "../src/signals/score.js";

// deliveries.event_id FKs into signal_events — insert real rows.
const ev = (key: string, from: SignalState, to: SignalState): SignalEventRow => {
  const db = getDb();
  const res = db
    .prepare("INSERT INTO signal_events (signal_key, from_state, to_state, value) VALUES (?, ?, ?, ?)")
    .run(key, from, to, 1.5);
  return db.prepare("SELECT * FROM signal_events WHERE id = ?").get(res.lastInsertRowid) as SignalEventRow;
};

const composite: CompositeResult = {
  score: 6,
  bucket: "elevated",
  probLabel: "≈35–60%",
  detail: {},
  modelProb: null,
};

const plusUser = (id: number) => {
  upsertUser(id, null, "en");
  setUserPlan(id, "plus");
  savePrefs(id, { delivery_mode: "instant" });
};

describe("publisher routing", () => {
  beforeEach(() => {
    setDb(createTestDb());
  });

  it("sends instant transitions to plus users only, never to channels", () => {
    upsertUser(1, null, "en"); // free
    plusUser(2);
    const n = routeEvent(ev("yield_curve_inversion", "ok", "warning"), composite);
    expect(n).toBe(1);
    const out = pendingDeliveries();
    expect(out).toHaveLength(1);
    expect(out[0].target_type).toBe("dm");
    expect(out[0].target_id).toBe("2");
  });

  it("respects plus delivery_mode=digest (no instant)", () => {
    plusUser(2);
    savePrefs(2, { delivery_mode: "digest" });
    expect(routeEvent(ev("yield_curve_inversion", "ok", "warning"), composite)).toBe(0);
  });

  it("gates nowcast signals on the nowcast_alerts pref", () => {
    plusUser(2);
    expect(routeEvent(ev("sahm_rule", "ok", "critical"), composite)).toBe(1);
    savePrefs(2, { nowcast_alerts: false });
    expect(routeEvent(ev("sahm_rule", "ok", "critical"), composite)).toBe(0);
  });

  it("honours per-user severity floor and enabled_signals", () => {
    plusUser(2);
    // watch-level transition: default floor is warning → filtered
    expect(routeEvent(ev("yield_curve_inversion", "ok", "watch"), composite)).toBe(0);
    savePrefs(2, { min_severity: "watch" });
    expect(routeEvent(ev("yield_curve_inversion", "ok", "watch"), composite)).toBe(1);
    // disabled signal → filtered
    savePrefs(2, { enabled_signals: ["sahm_rule"] });
    expect(routeEvent(ev("yield_curve_inversion", "ok", "critical"), composite)).toBe(0);
  });
});

describe("composite threshold alerts", () => {
  beforeEach(() => {
    setDb(createTestDb());
  });

  it("fires once on upward crossing only", () => {
    plusUser(2);
    savePrefs(2, { score_threshold: 5 });
    expect(routeCompositeAlerts(4.5, composite)).toBe(1); // 4.5 → 6 crosses 5
    expect(routeCompositeAlerts(6, composite)).toBe(0); // still above → no repeat
    expect(routeCompositeAlerts(null, composite)).toBe(0); // first run → skip
  });

  it("does not alert free users or below-threshold moves", () => {
    upsertUser(1, null, "en");
    savePrefs(1, { score_threshold: 5 }); // free — ignored
    expect(routeCompositeAlerts(4.5, composite)).toBe(0);
    plusUser(2); // no threshold set
    expect(routeCompositeAlerts(4.5, composite)).toBe(0);
  });
});
