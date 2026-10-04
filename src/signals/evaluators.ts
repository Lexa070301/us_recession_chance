import type { EvaluatorDef, Op } from "../config/schema.js";
import type { ObsRow } from "../data/repositories/observations.js";
import { SEVERITY_ORDER, type SignalState } from "../data/repositories/signalState.js";
import type { EvalResult, GetObs, PrevEvalState } from "./types.js";

const cmp = (op: Op, v: number, t: number): boolean => {
  switch (op) {
    case "<": return v < t;
    case "<=": return v <= t;
    case ">": return v > t;
    case ">=": return v >= t;
    case "==": return v === t;
  }
};

const ok: EvalResult = { state: "ok", value: null, since: null, context: {} };

const maxState = (a: SignalState, b: SignalState): SignalState =>
  SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;

const minState = (a: SignalState, b: SignalState): SignalState =>
  SEVERITY_ORDER[a] <= SEVERITY_ORDER[b] ? a : b;

/** Index of first element of the trailing run satisfying pred (all obs[n-1-k]). */
function trailingRunStart(obs: ObsRow[], pred: (v: number) => boolean): number {
  let i = obs.length - 1;
  while (i >= 0 && pred(obs[i].value)) i--;
  return i + 1;
}

// ------------------------------------------------------------------
// Individual evaluators — pure functions of the transformed series
// ------------------------------------------------------------------

function evalLevels(
  obs: ObsRow[],
  params: { levels: { state: SignalState; op: Op; threshold: number }[]; exit_below?: number; exit_above?: number },
  prev?: PrevEvalState,
): EvalResult {
  if (!obs.length) return ok;
  const last = obs[obs.length - 1].value;

  // Hard exit: below exit_below / above exit_above the state clears for real.
  if (params.exit_below !== undefined && last < params.exit_below) {
    return { ...ok, value: last, context: { last } };
  }
  if (params.exit_above !== undefined && last > params.exit_above) {
    return { ...ok, value: last, context: { last } };
  }

  // levels are checked in config order; first match wins (list strongest first)
  let state: SignalState = "ok";
  for (const lv of params.levels) {
    if (cmp(lv.op, last, lv.threshold)) {
      state = lv.state;
      break;
    }
  }

  // Hysteresis: no level matched but the value sits in the dead band between
  // the trigger and the exit threshold — keep the previous non-ok state.
  if (state === "ok" && prev && prev.state !== "ok") {
    const held =
      (params.exit_below !== undefined && last >= params.exit_below) ||
      (params.exit_above !== undefined && last <= params.exit_above);
    if (held) {
      return { state: prev.state, value: last, since: prev.since, context: { last, held: true } };
    }
  }
  if (state === "ok") return { ...ok, value: last, context: { last } };

  const anyLevel = (v: number) => params.levels.some((lv) => cmp(lv.op, v, lv.threshold));
  const start = trailingRunStart(obs, anyLevel);
  return {
    state,
    value: last,
    since: obs[start].date,
    context: { last, threshold: params.levels.find((lv) => lv.state === state)?.threshold },
  };
}

function evalEpisodeDuration(
  obs: ObsRow[],
  params: { op: Op; threshold: number; warn_periods: number; critical_periods?: number; exit_periods: number },
): EvalResult {
  if (!obs.length) return ok;
  const last = obs[obs.length - 1].value;
  const cond = (v: number) => cmp(params.op, v, params.threshold);

  // trailing run of condition=true
  const start = trailingRunStart(obs, cond);
  const runLen = obs.length - start;

  if (runLen >= params.warn_periods) {
    const state =
      params.critical_periods && runLen >= params.critical_periods ? "critical" : "warning";
    return {
      state,
      value: last,
      since: obs[start].date,
      context: { last, run_periods: runLen },
    };
  }

  // Cooling gap: a qualified breach run stays alive while fewer than
  // exit_periods consecutive non-breach obs follow it — regardless of whether
  // a new (still short) breach run has already started.
  if (params.exit_periods > 1) {
    let i = obs.length - 1 - runLen; // skip the trailing (short) breach run
    let gap = 0;
    while (i >= 0 && !cond(obs[i].value)) {
      gap++;
      i--;
    }
    const runStart = i + 1; // index just after the prior breach run
    let run = 0;
    while (i >= 0 && cond(obs[i].value)) {
      run++;
      i--;
    }
    if (run >= params.warn_periods && gap < params.exit_periods) {
      const state =
        params.critical_periods && run >= params.critical_periods ? "critical" : "warning";
      return {
        state,
        value: last,
        since: obs[Math.max(0, runStart - run)].date,
        context: { last, run_periods: run + runLen, cooling_gap: gap },
      };
    }
  }

  return { ...ok, value: last, context: { last, run_periods: runLen } };
}

function evalStreak(
  obs: ObsRow[],
  params: { direction: "up" | "down"; warn_count: number; critical_count?: number },
): EvalResult {
  if (obs.length < 2) return ok;
  const dir = params.direction === "up" ? 1 : -1;
  const okMove = (i: number) => (obs[i].value - obs[i - 1].value) * dir > 0;

  let streak = 0;
  for (let i = obs.length - 1; i > 0 && okMove(i); i--) streak++;

  const last = obs[obs.length - 1].value;
  if (streak < params.warn_count) return { ...ok, value: last, context: { last, streak } };

  const state = params.critical_count && streak >= params.critical_count ? "critical" : "warning";
  return {
    state,
    value: last,
    since: obs[obs.length - 1 - streak].date,
    context: { last, streak },
  };
}

function evalRiseFromTrough(
  obs: ObsRow[],
  params: { window: number; rise_pct?: number; rise_abs?: number; critical_pct?: number; critical_abs?: number },
): EvalResult {
  if (!obs.length) return ok;
  const win = obs.slice(-params.window);
  let min = Infinity;
  let minIdx = 0;
  win.forEach((o, i) => {
    if (o.value < min) {
      min = o.value;
      minIdx = i;
    }
  });
  const last = win[win.length - 1].value;
  const riseAbs = last - min;
  const risePct = min !== 0 ? (riseAbs / Math.abs(min)) * 100 : 0;

  let state: SignalState = "ok";
  if (params.critical_pct !== undefined && risePct >= params.critical_pct) state = "critical";
  if (params.critical_abs !== undefined && riseAbs >= params.critical_abs) state = "critical";
  if (state === "ok") {
    if (params.rise_pct !== undefined && risePct >= params.rise_pct) state = "warning";
    if (params.rise_abs !== undefined && riseAbs >= params.rise_abs) state = "warning";
  }
  if (state === "ok") return { ...ok, value: last, context: { last, trough: min, rise_pct: risePct } };

  return {
    state,
    value: last,
    since: win[minIdx].date,
    context: { last, trough: min, trough_date: win[minIdx].date, rise_pct: risePct, rise_abs: riseAbs },
  };
}

function evalChangeOverPeriod(
  obs: ObsRow[],
  params: { periods: number; op: Op; warn: number; critical?: number; ref_below?: number },
): EvalResult {
  if (obs.length <= params.periods) return ok;
  const last = obs[obs.length - 1].value;
  const ref = obs[obs.length - 1 - params.periods];
  const delta = last - ref.value;

  // optional gate: only count changes that START below a level
  // (e.g. ref_below: 0 = steepening out of inversion, not from flat)
  if (params.ref_below !== undefined && ref.value >= params.ref_below) {
    return { ...ok, value: last, context: { last, delta, periods: params.periods } };
  }

  let state: SignalState = "ok";
  if (params.critical !== undefined && cmp(params.op, delta, params.critical)) state = "critical";
  else if (cmp(params.op, delta, params.warn)) state = "warning";

  if (state === "ok") return { ...ok, value: last, context: { last, delta, periods: params.periods } };
  return {
    state,
    value: last,
    since: ref.date,
    context: { last, delta, periods: params.periods, ref_date: ref.date, ref_value: ref.value },
  };
}

function evalYoy(
  obs: ObsRow[],
  params: { op: Op; threshold: number; warn: number; critical?: number },
  periodsBack = 12,
): EvalResult {
  if (obs.length <= periodsBack) return ok;
  const last = obs[obs.length - 1].value;
  // yoy series aligned to obs indices starting at periodsBack; PERCENT change
  const yoy: ObsRow[] = [];
  for (let i = periodsBack; i < obs.length; i++) {
    const prevVal = obs[i - periodsBack].value;
    if (prevVal === 0) continue;
    yoy.push({
      date: obs[i].date,
      value: ((obs[i].value - prevVal) / Math.abs(prevVal)) * 100,
    });
  }
  if (!yoy.length) return ok;
  const lastYoy = yoy[yoy.length - 1].value;

  const crit = params.critical;
  if (crit !== undefined && cmp(params.op, lastYoy, crit)) {
    const start = trailingRunStart(yoy, (v) => cmp(params.op, v, crit));
    return {
      state: "critical",
      value: last,
      since: yoy[start].date,
      context: { last, yoy: lastYoy },
    };
  }

  const start = trailingRunStart(yoy, (v) => cmp(params.op, v, params.threshold));
  const consec = yoy.length - start;
  if (consec < params.warn) return { ...ok, value: last, context: { last, yoy: lastYoy, consec } };
  return {
    state: "warning",
    value: last,
    since: yoy[start].date,
    context: { last, yoy: lastYoy, consec },
  };
}

// ------------------------------------------------------------------
// Dispatcher
// ------------------------------------------------------------------

export function evaluate(
  ev: EvaluatorDef,
  getObs: GetObs,
  yoyPeriods = 12,
  prev?: PrevEvalState,
): EvalResult {
  switch (ev.type) {
    case "levels":
      return evalLevels(getObs(ev.input), ev.params, prev);
    case "episode_duration":
      return evalEpisodeDuration(getObs(ev.input), ev.params);
    case "streak":
      return evalStreak(getObs(ev.input), ev.params);
    case "rise_from_trough":
      return evalRiseFromTrough(getObs(ev.input), ev.params);
    case "change_over_period":
      return evalChangeOverPeriod(getObs(ev.input), ev.params);
    case "yoy":
      return evalYoy(getObs(ev.input), ev.params, yoyPeriods);
    case "sahm_states": {
      // Regional nowcast (PLAN2 §7): count state UR series whose Sahm
      // transform (MA3 − 12m min of MA3) exceeds the trigger. Experimental —
      // states are noisier than the national rule; no hist stats.
      const triggered: { key: string; val: number }[] = [];
      let lastDate: string | null = null;
      for (const key of ev.params.keys) {
        const series = getObs({ key, transform: "sahm" });
        const last = series[series.length - 1];
        if (!last) continue;
        if (!lastDate || last.date > lastDate) lastDate = last.date;
        if (last.value >= ev.params.trigger) triggered.push({ key, val: last.value });
      }
      triggered.sort((a, b) => b.val - a.val);
      const count = triggered.length;
      const state: SignalState =
        ev.params.critical_count !== undefined && count >= ev.params.critical_count
          ? "critical"
          : count >= ev.params.warn_count
            ? "warning"
            : "ok";
      return {
        state,
        value: count,
        // Episode continuity: keep the stored episode start while the
        // signal stays non-ok — lastDate alone is just the newest obs.
        since: state === "ok" ? null : (prev && prev.state !== "ok" && prev.since ? prev.since : lastDate),
        context: {
          count,
          total: ev.params.keys.length,
          trigger: ev.params.trigger,
          top: triggered.slice(0, 3).map((s) => ({ key: s.key, val: Number(s.val.toFixed(2)) })),
        },
      };
    }
    case "any_of": {
      const results = ev.branches.map((b) => evaluate(b, getObs, yoyPeriods, prev));
      const top = results.reduce<EvalResult>((acc, r) =>
        SEVERITY_ORDER[r.state] > SEVERITY_ORDER[acc.state] ? r : acc,
      results[0]);
      return { ...top, context: { ...top.context, branches: results.map((r) => r.state) } };
    }
    case "all_of": {
      const results = ev.branches.map((b) => evaluate(b, getObs, yoyPeriods, prev));
      const weakest = results.reduce<SignalState>((acc, r) => minState(acc, r.state), "critical");
      const strongest = results.reduce<SignalState>((acc, r) => maxState(acc, r.state), "ok");
      const topVal = results.find((r) => r.value !== null)?.value ?? null;
      const topSince = results.reduce<string | null>((acc, r) => {
        if (!r.since) return acc;
        return !acc || r.since < acc ? r.since : acc;
      }, null);
      return {
        state: weakest,
        value: topVal,
        since: weakest === "ok" ? null : topSince,
        context: { branches: results.map((r) => r.state), max_branch: strongest },
      };
    }
  }
}
