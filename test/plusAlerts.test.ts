import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, getDb, setDb } from "../src/data/db.js";
import { enqueueDelivery, pendingDeliveries } from "../src/data/repositories/deliveries.js";
import type { SignalEventRow, SignalState } from "../src/data/repositories/signalState.js";
import {
  activateSubscription,
  listExpiringSubscriptions,
  markExpiryReminded,
} from "../src/data/repositories/subscriptions.js";
import {
  quietHoursUntil,
  savePrefs,
  setUserPlan,
  upsertUser,
} from "../src/data/repositories/users.js";
import { routeBucketAlert, routeCompositeAlerts, routeEvent } from "../src/publish/publisher.js";
import type { CompositeResult } from "../src/signals/score.js";

const ev = (key: string, from: SignalState, to: SignalState): SignalEventRow => {
  const db = getDb();
  const res = db
    .prepare("INSERT INTO signal_events (signal_key, from_state, to_state, value) VALUES (?, ?, ?, ?)")
    .run(key, from, to, 1.5);
  return db.prepare("SELECT * FROM signal_events WHERE id = ?").get(res.lastInsertRowid) as SignalEventRow;
};

const elevated: CompositeResult = {
  score: 6,
  bucket: "elevated",
  probLabel: "≈35–60%",
  detail: {},
  modelProb: null,
};
const severe: CompositeResult = { ...elevated, score: 14, bucket: "severe" };
const low: CompositeResult = { ...elevated, score: 1, bucket: "low", probLabel: "<15%" };

const plusUser = (id: number) => {
  upsertUser(id, null, "en");
  setUserPlan(id, "plus");
  savePrefs(id, { delivery_mode: "instant" });
};

const allDeliveries = () =>
  getDb().prepare("SELECT * FROM deliveries ORDER BY id").all() as {
    not_before: string | null;
    payload_text: string | null;
  }[];

describe("quietHoursUntil", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 5, h, 30));

  it("returns the window end inside same-day and wrap-around windows", () => {
    expect(quietHoursUntil({ from: 22, to: 8 }, at(23))?.endsWith("08:00:00")).toBe(true);
    expect(quietHoursUntil({ from: 22, to: 8 }, at(3))?.endsWith("08:00:00")).toBe(true);
    expect(quietHoursUntil({ from: 0, to: 8 }, at(5))).toContain("08:00:00");
  });

  it("is null outside the window, for null, and for from===to", () => {
    expect(quietHoursUntil({ from: 22, to: 8 }, at(12))).toBeNull();
    expect(quietHoursUntil(null, at(3))).toBeNull();
    expect(quietHoursUntil({ from: 8, to: 8 }, at(3))).toBeNull();
  });
});

describe("quiet-hours deferral", () => {
  beforeEach(() => {
    setDb(createTestDb());
  });

  it("defers non-critical alerts to the window end, delivers critical instantly", () => {
    plusUser(2);
    savePrefs(2, { quiet_hours: { from: 0, to: 24 } }); // always quiet — deterministic
    expect(routeEvent(ev("yield_curve_inversion", "ok", "warning"), elevated)).toBe(1);
    expect(routeEvent(ev("yield_curve_inversion", "warning", "critical"), elevated)).toBe(1);
    const [warned, critical] = allDeliveries();
    expect(warned.not_before).not.toBeNull();
    expect(critical.not_before).toBeNull();
    // deferred rows wait; the critical one is pending now
    expect(pendingDeliveries().map((d) => d.not_before)).toEqual([null]);
  });

  it("defers composite alerts unless the new band is high/severe", () => {
    plusUser(2);
    savePrefs(2, { score_threshold: 5, quiet_hours: { from: 0, to: 24 } });
    routeCompositeAlerts(4.5, elevated);
    routeCompositeAlerts(4.5, severe); // 4.5 → 14 crosses 5; severe band bypasses quiet hours
    const rows = allDeliveries();
    expect(rows[0].not_before).not.toBeNull();
    expect(rows[1].not_before).toBeNull();
  });
});

describe("band-change alerts", () => {
  beforeEach(() => {
    setDb(createTestDb());
  });

  it("fires in both directions, once per transition, to all plus users", () => {
    plusUser(2);
    savePrefs(2, { delivery_mode: "digest" }); // still gets band alerts
    expect(routeBucketAlert("low", elevated)).toBe(1);
    expect(allDeliveries()[0].payload_text).toContain("Risk band: LOW → ELEVATED");

    expect(routeBucketAlert("elevated", elevated)).toBe(0); // no change → no alert
    expect(routeBucketAlert(null, elevated)).toBe(0); // first run → no alert

    expect(routeBucketAlert("elevated", low)).toBe(1); // de-escalation
    expect(allDeliveries()[1].payload_text).toContain("Risk band eased: ELEVATED → LOW");
  });

  it("never alerts free users", () => {
    upsertUser(1, null, "en");
    expect(routeBucketAlert("low", elevated)).toBe(0);
  });
});

describe("renewal reminders", () => {
  beforeEach(() => {
    setDb(createTestDb());
  });

  it("lists subs expiring inside the window, marks them, resets on renewal", () => {
    upsertUser(1, null, "en");
    activateSubscription(1, 30, "c1"); // ~30d out — outside the 72h window
    expect(listExpiringSubscriptions(72)).toHaveLength(0);

    getDb()
      .prepare("UPDATE subscriptions SET expires_at = datetime('now', '+2 days') WHERE user_id = 1")
      .run();
    expect(listExpiringSubscriptions(72).map((s) => s.user_id)).toEqual([1]);

    markExpiryReminded(1);
    expect(listExpiringSubscriptions(72)).toHaveLength(0); // reminded → quiet

    activateSubscription(1, 30, "c2"); // renewal resets the flag
    getDb()
      .prepare("UPDATE subscriptions SET expires_at = datetime('now', '+2 days') WHERE user_id = 1")
      .run();
    expect(listExpiringSubscriptions(72)).toHaveLength(1);
  });
});

describe("deferred deliveries", () => {
  beforeEach(() => {
    setDb(createTestDb());
  });

  it("not_before holds rows out of the pending queue", () => {
    enqueueDelivery({
      targetType: "dm",
      targetId: "2",
      locale: "en",
      payloadText: "later",
      notBefore: "2999-01-01 00:00:00",
    });
    enqueueDelivery({ targetType: "dm", targetId: "3", locale: "en", payloadText: "now" });
    const pending = pendingDeliveries();
    expect(pending).toHaveLength(1);
    expect(pending[0].payload_text).toBe("now");
  });
});
