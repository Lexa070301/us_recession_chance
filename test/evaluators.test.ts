import { describe, expect, it } from "vitest";
import { evaluate } from "../src/signals/evaluators.js";
import type { ObsRow } from "../src/data/repositories/observations.js";
import type { EvaluatorDef } from "../src/config/schema.js";

const obs = (values: number[]): ObsRow[] =>
  values.map((v, i) => ({ date: `2024-01-${String(i + 1).padStart(2, "0")}`, value: v }));

const getObs =
  (rows: ObsRow[]) =>
  (): ObsRow[] =>
    rows;

describe("episode_duration", () => {
  const ev: EvaluatorDef = {
    type: "episode_duration",
    params: { op: "<", threshold: 0, warn_periods: 10, critical_periods: 15, exit_periods: 5 },
  };

  it("ok when fewer than warn_periods", () => {
    const r = evaluate(ev, getObs(obs([1, 1, -1, -1, -1])));
    expect(r.state).toBe("ok");
  });

  it("warning at warn_periods, critical at critical_periods", () => {
    const r = evaluate(ev, getObs(obs([1, ...Array(12).fill(-1)])));
    expect(r.state).toBe("warning");
    expect(r.context.run_periods).toBe(12);
    const c = evaluate(ev, getObs(obs([1, ...Array(20).fill(-1)])));
    expect(c.state).toBe("critical");
  });

  it("clears immediately when exit_periods = 1", () => {
    const strict: EvaluatorDef = {
      type: "episode_duration",
      params: { op: "<", threshold: 0, warn_periods: 10, critical_periods: 15, exit_periods: 1 },
    };
    const r = evaluate(strict, getObs(obs([...Array(15).fill(-1), 1])));
    expect(r.state).toBe("ok");
  });

  it("stays active through gap < exit_periods", () => {
    const rows = obs([...Array(15).fill(-1), 1, 1]); // gap of 2 < exit 5
    const r = evaluate(ev, getObs(rows));
    expect(r.state).toBe("critical");
    expect(r.context.cooling_gap).toBe(2);
  });

  it("clears when gap >= exit_periods", () => {
    const rows = obs([...Array(15).fill(-1), 1, 1, 1, 1, 1]); // gap 5 >= exit 5
    const r = evaluate(ev, getObs(rows));
    expect(r.state).toBe("ok");
  });

  it("keeps episode through short gap + short re-breach", () => {
    // 15 breach, 2 non-breach (< exit 5), then breach resumes but only 1 obs
    const rows = obs([...Array(15).fill(-1), 1, 1, -1]);
    const r = evaluate(ev, getObs(rows));
    expect(r.state).toBe("critical"); // episode never died
    expect(r.since).toBe("2024-01-01"); // original episode start, not the gap
  });

  it("episode dies when gap >= exit even with a re-breach", () => {
    const rows = obs([...Array(15).fill(-1), 1, 1, 1, 1, 1, -1]);
    expect(evaluate(ev, getObs(rows)).state).toBe("ok");
  });
});

describe("levels", () => {
  const ev: EvaluatorDef = {
    type: "levels",
    params: {
      levels: [
        { state: "critical", op: ">", threshold: 40 },
        { state: "warning", op: ">", threshold: 30 },
      ],
      exit_below: 25,
    },
  };

  it("picks strongest matching level", () => {
    expect(evaluate(ev, getObs(obs([10, 45]))).state).toBe("critical");
    expect(evaluate(ev, getObs(obs([10, 35]))).state).toBe("warning");
    expect(evaluate(ev, getObs(obs([10, 26]))).state).toBe("ok");
  });

  it("exit_below forces ok", () => {
    expect(evaluate(ev, getObs(obs([45, 20]))).state).toBe("ok");
  });

  it("hysteresis: dead band between exit and trigger holds prev state", () => {
    const prev = { state: "warning" as const, since: "2024-01-01" };
    // 27 is below trigger(30) but above exit(25) — without prev it would flip to ok
    const held = evaluate(ev, getObs(obs([45, 27])), 12, prev);
    expect(held.state).toBe("warning");
    expect(held.since).toBe("2024-01-01");
    // without a stored state the same value is ok (no hysteresis)
    expect(evaluate(ev, getObs(obs([45, 27]))).state).toBe("ok");
    // genuinely below the exit → clears even with prev set
    expect(evaluate(ev, getObs(obs([45, 20])), 12, prev).state).toBe("ok");
  });
});

describe("streak", () => {
  const ev: EvaluatorDef = {
    type: "streak",
    params: { direction: "up", warn_count: 3, critical_count: 5 },
  };

  it("counts trailing increases", () => {
    expect(evaluate(ev, getObs(obs([1, 2, 3, 4]))).state).toBe("warning");
    expect(evaluate(ev, getObs(obs([1, 2, 3, 4, 5, 6]))).state).toBe("critical");
    expect(evaluate(ev, getObs(obs([1, 2, 1]))).state).toBe("ok");
  });
});

describe("rise_from_trough", () => {
  const ev: EvaluatorDef = {
    type: "rise_from_trough",
    params: { window: 10, rise_pct: 15, critical_pct: 25 },
  };

  it("warns when risen >15% from trough, critical >25%", () => {
    expect(evaluate(ev, getObs(obs([100, 100, 116]))).state).toBe("warning");
    expect(evaluate(ev, getObs(obs([100, 100, 126]))).state).toBe("critical");
    expect(evaluate(ev, getObs(obs([100, 100, 110]))).state).toBe("ok");
  });
});

describe("change_over_period", () => {
  const ev: EvaluatorDef = {
    type: "change_over_period",
    params: { periods: 3, op: ">", warn: 1.0, critical: 2.0 },
  };

  it("compares last vs N periods back", () => {
    expect(evaluate(ev, getObs(obs([0, 0, 0, 1.5]))).state).toBe("warning");
    expect(evaluate(ev, getObs(obs([0, 0, 0, 2.5]))).state).toBe("critical");
    expect(evaluate(ev, getObs(obs([0, 0, 0, 0.5]))).state).toBe("ok");
  });
});

describe("yoy", () => {
  const ev: EvaluatorDef = {
    type: "yoy",
    params: { op: "<", threshold: 0, warn: 3, critical: -10 },
  };

  // 13 monthly obs; last 3 months declining YoY
  const monthly = (values: number[]): ObsRow[] =>
    values.map((v, i) => ({ date: `2024-${String((i % 12) + 1).padStart(2, "0")}-01`, value: v }));

  it("warning after 3 consecutive negative yoy", () => {
    const rows = monthly([...Array(10).fill(100), 99, 98, 97]);
    const r = evaluate(ev, getObs(rows), 12);
    expect(r.context.yoy).toBe(-3);
    // need 3 consecutive => provide 15 points
    const rows2 = monthly([...Array(12).fill(100), 99, 98, 97]);
    const r2 = evaluate(ev, getObs(rows2), 12);
    expect(r2.state).toBe("warning");
  });

  it("critical when yoy < -10 regardless of streak", () => {
    const rows = monthly([...Array(12).fill(100), 89]);
    const r = evaluate(ev, getObs(rows), 12);
    expect(r.state).toBe("critical");
  });

  it("yoy is a PERCENT change (audit fix): -9 in a 1400-base series is not critical", () => {
    const rows = monthly([...Array(12).fill(1400), 1391]); // -0.64% — abs drop 9 < 10
    const r = evaluate(ev, getObs(rows), 12);
    expect(r.state).toBe("ok");
    const rows2 = monthly([...Array(12).fill(1400), 1200]); // -14.3% — critical
    expect(evaluate(ev, getObs(rows2), 12).state).toBe("critical");
  });
});

describe("any_of / all_of", () => {
  const anyEv: EvaluatorDef = {
    type: "any_of",
    branches: [
      { type: "levels", params: { levels: [{ state: "warning", op: ">", threshold: 5 }] } },
      { type: "levels", params: { levels: [{ state: "warning", op: "<", threshold: 0 }] } },
    ],
  };
  const allEv: EvaluatorDef = {
    type: "all_of",
    branches: [
      { type: "levels", params: { levels: [{ state: "warning", op: ">", threshold: 5 }] } },
      { type: "levels", params: { levels: [{ state: "warning", op: ">", threshold: 4 }] } },
    ],
  };

  it("any_of = max severity, all_of = weakest branch", () => {
    expect(evaluate(anyEv, getObs(obs([6]))).state).toBe("warning");
    expect(evaluate(anyEv, getObs(obs([3]))).state).toBe("ok");
    expect(evaluate(allEv, getObs(obs([6]))).state).toBe("warning"); // both hold
    expect(evaluate(allEv, getObs(obs([4.5]))).state).toBe("ok"); // only branch 2
  });
});
