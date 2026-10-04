import { describe, expect, it } from "vitest";
import { createTestDb } from "../src/data/db.js";
import {
  getEventsSince,
  getSignalState,
  transitionSignalState,
} from "../src/data/repositories/signalState.js";
import { shouldSuppressEvent } from "../src/signals/engine.js";

const ts = (iso: string) => iso.replace("T", " ").slice(0, 19);

describe("shouldSuppressEvent", () => {
  const now = Date.parse("2025-06-01T12:00:00Z");

  it("suppresses transitions inside the gap", () => {
    const last = { ts: ts("2025-05-31T12:00:00Z") }; // 24h ago
    expect(shouldSuppressEvent(72, last, "warning", now)).toBe(true);
  });

  it("lets transitions through after the gap", () => {
    const last = { ts: ts("2025-05-28T12:00:00Z") }; // 96h ago
    expect(shouldSuppressEvent(72, last, "warning", now)).toBe(false);
  });

  it("never suppresses escalation to critical (alert-safety)", () => {
    const last = { ts: ts("2025-06-01T11:00:00Z") }; // 1h ago
    expect(shouldSuppressEvent(72, last, "critical", now)).toBe(false);
  });

  it("is a no-op without a configured gap or last event", () => {
    expect(shouldSuppressEvent(undefined, { ts: ts("2025-06-01T11:00:00Z") }, "warning", now)).toBe(false);
    expect(shouldSuppressEvent(72, undefined, "warning", now)).toBe(false);
  });
});

describe("transitionSignalState suppressEvent", () => {
  const base = {
    since: null,
    episodeStart: null,
    value: 1,
    obsDate: "2025-06-01",
  };

  it("updates the state row but inserts no event", () => {
    const db = createTestDb();
    const id1 = transitionSignalState(
      "sig_x",
      { ...base, state: "warning" },
      db,
    );
    expect(id1).not.toBeNull();

    const id2 = transitionSignalState(
      "sig_x",
      { ...base, state: "ok", context: { suppressed: { from: "warning", to: "ok" } } },
      db,
      { suppressEvent: true },
    );
    expect(id2).toBeNull();

    const st = getSignalState("sig_x", db);
    expect(st.state).toBe("ok");
    // suppression marker persisted in context
    expect(JSON.parse(st.context_json!).suppressed).toEqual({ from: "warning", to: "ok" });
    // only the first (unsuppressed) event exists
    const events = getEventsSince("2000-01-01 00:00:00", db);
    expect(events).toHaveLength(1);
    expect(events[0].to_state).toBe("warning");
  });
});
