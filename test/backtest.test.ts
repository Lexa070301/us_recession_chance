import { describe, expect, it } from "vitest";
import { createTestDb } from "../src/data/db.js";
import { upsertObservations, getObservations } from "../src/data/repositories/observations.js";
import { getRecessionPeriods } from "../src/data/nber.js";
import {
  detectEpisodes,
  latestSource,
  monthAdd,
  monthEnd,
  monthIndex,
  SeriesCache,
  type StatePoint,
} from "../src/backtest/replay.js";
import { signalBacktest } from "../src/backtest/stats.js";
import { fitLogit, predictProb, reliability } from "../src/backtest/logit.js";
import type { SignalDef } from "../src/config/schema.js";

describe("date helpers", () => {
  it("monthIndex/monthAdd roundtrip", () => {
    expect(monthIndex("2001-03-15")).toBe(2001 * 12 + 2);
    expect(monthAdd("2001-03-15", 14)).toBe("2002-05");
    expect(monthAdd("2020-12-31", 1)).toBe("2021-01");
  });
  it("monthEnd gives last calendar day", () => {
    expect(monthEnd("2024-02")).toBe("2024-02-29");
    expect(monthEnd("2021-04")).toBe("2021-04-30");
  });
});

describe("detectEpisodes", () => {
  const st = (date: string, state: StatePoint["state"]): StatePoint => ({ date, state });

  it("merges runs separated by < 6 months of ok", () => {
    const states = [
      st("2000-01-01", "ok"),
      st("2000-02-01", "warning"),
      st("2000-03-01", "ok"), // gap of 3 months
      st("2000-06-01", "critical"),
      st("2000-07-01", "ok"),
    ];
    const eps = detectEpisodes(states);
    expect(eps).toHaveLength(1);
    expect(eps[0].start).toBe("2000-02-01");
    expect(eps[0].peak).toBe("critical");
  });

  it("separates runs after >= 6 months of ok", () => {
    const states = [
      st("2000-01-01", "warning"),
      st("2000-02-01", "ok"),
      st("2000-09-01", "warning"), // 7 months later
      st("2000-10-01", "ok"),
    ];
    const eps = detectEpisodes(states);
    expect(eps).toHaveLength(2);
  });

  it("keeps open episode when still active at sample end", () => {
    const eps = detectEpisodes([st("2000-01-01", "ok"), st("2000-02-01", "warning")]);
    expect(eps[0].end).toBeNull();
  });
});

describe("signalBacktest (synthetic)", () => {
  it("counts a hit when recession starts within 12m of onset", () => {
    const db = createTestDb();
    // unrate monthly 1999-01..2005-12; spike >7 during 2003-01..2003-06
    const un: { date: string; value: number }[] = [];
    const us: { date: string; value: number }[] = [];
    for (let m = "1999-01"; m <= "2005-12"; m = monthAdd(m, 1)) {
      const inSpike = m >= "2003-01" && m <= "2003-06";
      un.push({ date: `${m}-01`, value: inSpike ? 8 : 4 });
      const inRec = m >= "2003-06" && m <= "2003-11";
      us.push({ date: `${m}-01`, value: inRec ? 1 : 0 });
    }
    upsertObservations("unrate", un, "", db);
    upsertObservations("usrec", us, "", db);

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

    const recessions = getRecessionPeriods(db);
    expect(recessions).toHaveLength(1);
    expect(recessions[0].start).toBe("2003-06");

    const bt = signalBacktest(signal, latestSource(new SeriesCache(db)), recessions, "2005-12");
    expect(bt.episodes.length - bt.censored).toBe(1);
    expect(bt.hits).toBe(1);
    expect(bt.precision).toBe(1);
    expect(bt.recall).toBe(1);
    // onset knowledge date = 2003-01-01 + 45d = ~2003-02; lead to 2003-06 = 4 months
    expect(bt.medianLeadMonths).toBe(4);
  });

  it("censors episodes whose 12m window extends past the sample", () => {
    const db = createTestDb();
    const un = [{ date: "2020-01-01", value: 8 }];
    const us = [{ date: "2020-01-01", value: 0 }];
    upsertObservations("unrate", un, "", db);
    upsertObservations("usrec", us, "", db);

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
    const bt = signalBacktest(signal, latestSource(new SeriesCache(db)), [], "2020-01");
    expect(bt.censored).toBe(1);
    expect(bt.precision).toBeNull();
  });
});

describe("fitLogit", () => {
  it("recovers direction on separable synthetic data", () => {
    // x<0 -> y=0, x>0 -> y=1 (with a couple of mistakes to keep it finite)
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = -20; i <= 20; i++) {
      X.push([i / 10]);
      y.push(i > 0 ? 1 : 0);
    }
    y[5] = 0; // noise
    const fit = fitLogit(X, y);
    expect(fit.betaRaw[1]).toBeGreaterThan(0);
    expect(fit.mcfaddenR2).toBeGreaterThan(0.5);
    const pPos = predictProb(fit.betaStd, fit.means, fit.stds, [1]);
    const pNeg = predictProb(fit.betaStd, fit.means, fit.stds, [-1]);
    expect(pPos).toBeGreaterThan(0.8);
    expect(pNeg).toBeLessThan(0.2);
  });

  it("reliability bins cover the sample", () => {
    const probs = [0.05, 0.15, 0.5, 0.9];
    const y = [0, 0, 1, 1];
    const bins = reliability(probs, y, 4);
    expect(bins.reduce((s, b) => s + b.n, 0)).toBe(4);
  });
});
