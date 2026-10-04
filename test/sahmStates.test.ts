import { describe, it, expect } from "vitest";
import { sahmRule, applyTransform } from "../src/metrics/transforms.js";
import { evaluate } from "../src/signals/evaluators.js";
import { Panel } from "../src/metrics/panel.js";
import type { EvaluatorDef, SignalDef } from "../src/config/schema.js";
import type { ObsRow } from "../src/data/repositories/observations.js";

process.env.FRED_API_KEY ??= "test-key";

const obs = (vals: number[], start = "2020-01-01"): ObsRow[] =>
  vals.map((value, i) => {
    const d = new Date(start);
    d.setMonth(d.getMonth() + i);
    return { date: d.toISOString().slice(0, 10), value };
  });

describe("sahm transform", () => {
  it("computes MA3 − 12m min of MA3", () => {
    // 15 flat obs then a jump: MA3 = [.., 3.0 x13, 3.33, 4.33]; last min12 = 3.0
    const series = obs([...Array(14).fill(3), 6]);
    const out = sahmRule(series);
    const last = out[out.length - 1];
    // MA3 of last 3 = (3+3+6)/3 = 4.0; min MA3 over 12m = 3.0 → diff 1.0
    expect(last.value).toBeCloseTo(1.0, 5);
  });

  it("returns empty until 14 obs (3 MA + 12 window)", () => {
    expect(sahmRule(obs(Array(13).fill(3)))).toHaveLength(0);
    expect(sahmRule(obs(Array(14).fill(3)))).toHaveLength(1);
  });

  it("registers in the transform registry", () => {
    expect(() => applyTransform(obs(Array(14).fill(3)), "sahm")).not.toThrow();
  });
});

describe("sahm_states evaluator", () => {
  const ev: EvaluatorDef = {
    type: "sahm_states",
    params: { keys: ["s1", "s2", "s3"], trigger: 0.5, warn_count: 2, critical_count: 3 },
  };
  // getObs resolves refs through the sahm transform (as Panel.resolve does),
  // so the stubs feed sahm-transformed values, not raw UR levels.
  const hot = [{ date: "2026-01-01", value: 0.7 }];
  const calm = [{ date: "2026-01-01", value: 0.1 }];

  it("counts triggered series; escalates by count", () => {
    const getObs = (ref?: { key: string }) =>
      ref?.key === "s3" ? calm : ref?.key === "s1" || ref?.key === "s2" ? hot : [];
    const res = evaluate(ev, getObs as never);
    expect(res.state).toBe("warning"); // 2 ≥ warn_count, < critical_count
    expect(res.value).toBe(2);
    expect((res.context.top as unknown[]).length).toBe(2);
  });

  it("critical at critical_count", () => {
    const res = evaluate(ev, (() => hot) as never);
    expect(res.state).toBe("critical");
    expect(res.value).toBe(3);
  });

  it("ok when nothing triggered", () => {
    const res = evaluate(ev, (() => calm) as never);
    expect(res.state).toBe("ok");
    expect(res.since).toBeNull();
  });
});

describe("Panel.signalInputs with sahm_states", () => {
  it("walks params.keys as sahm-transform refs so latestObsDate tracks them", () => {
    const signal = {
      key: "sahm_states",
      input: { key: "unrate", transform: "value" },
      evaluator: {
        type: "sahm_states",
        params: { keys: ["ur_state_ca", "ur_state_tx"], trigger: 0.5, warn_count: 1 },
      },
    } as unknown as SignalDef;
    const refs = Panel.signalInputs(signal).map((r) => `${r.key}|${r.transform}`);
    expect(refs).toContain("ur_state_ca|sahm");
    expect(refs).toContain("ur_state_tx|sahm");
    expect(refs).toContain("unrate|value");
  });
});
