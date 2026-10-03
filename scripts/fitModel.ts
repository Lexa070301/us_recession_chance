import "dotenv/config";
import { getDb } from "../src/data/db.js";
import { getRecessionPeriods } from "../src/data/nber.js";
import { getObservations, type ObsRow } from "../src/data/repositories/observations.js";
import { monthlyMean, diff, pctChange, movingAverage } from "../src/metrics/transforms.js";
import { monthAdd, monthIndex } from "../src/backtest/replay.js";
import { POST_REC_SHADOW_MONTHS } from "../src/backtest/stats.js";
import { fitLogit, predictProb, reliability } from "../src/backtest/logit.js";

/**
 * Pooled 12-month recession logit (Phase 5). Predictors are deliberately one
 * per economic block — correlated signals from the same block would double
 * count information. Run after `npm run backfill -- 60`.
 *
 * Output: coefficients (raw + standardized units), fit stats, reliability
 * table, and a `pooled_logit:` YAML block to paste into config/model.yaml.
 * The fitted model is NOT wired into scoring yet — review the stats first.
 *
 * Usage: npm run fit-model
 */

const HORIZON = 12;

type Op = { t: "monthly_mean" | "ma" | "diff" | "pct_change"; n?: number };

interface Feature {
  name: string;
  key: string;
  ops: Op[];
}

const db = getDb();
const obs = (key: string) => getObservations(key, {}, db);

const applyOps = (o: ObsRow[], ops: Op[]): ObsRow[] =>
  ops.reduce((acc, op) => {
    switch (op.t) {
      case "monthly_mean": return monthlyMean(acc);
      case "ma": return movingAverage(acc, op.n ?? 1);
      case "diff": return diff(acc, op.n ?? 1);
      case "pct_change": return pctChange(acc, op.n ?? 1);
    }
  }, o);

// One predictor per block; resampled to a monthly grid. `key`/`ops` are
// emitted into pooled_logit config — pooledProb.ts replays them at runtime.
const FEATURES: Feature[] = [
  { name: "spread_10y3m_m", key: "yield_10y3m", ops: [{ t: "monthly_mean" }] },
  { name: "nfci_m", key: "nfci", ops: [{ t: "monthly_mean" }] },
  { name: "cfnaid_ma3", key: "cfnaid", ops: [{ t: "ma", n: 3 }] },
  { name: "claims_yoy_pct", key: "icsa", ops: [{ t: "monthly_mean" }, { t: "pct_change", n: 12 }] },
  { name: "permit_yoy", key: "permits", ops: [{ t: "pct_change", n: 12 }] },
  { name: "unrate_chg3m", key: "unrate", ops: [{ t: "diff", n: 3 }] },
];

const pad = (s: string, n: number) => s.padEnd(n);

function main() {
  const usrec = obs("usrec");
  if (!usrec.length) {
    console.error("No `usrec` observations — run `npm run backfill -- 60` first.");
    process.exit(1);
  }
  const usrecLastMonth = usrec[usrec.length - 1].date.slice(0, 7);
  const recessions = getRecessionPeriods(db);

  const startSet = new Set(recessions.map((r) => r.start));
  const inRec = new Set<string>();
  const postRecShadow = new Set<string>();
  for (const r of recessions) {
    for (let m = r.start; m <= r.end; m = monthAdd(m, 1)) inRec.add(m);
    for (let h = 1; h <= POST_REC_SHADOW_MONTHS; h++) postRecShadow.add(monthAdd(r.end, h));
  }

  // month -> feature vector (inner join on available months)
  const byFeature = FEATURES.map((f) => {
    const m = new Map<string, number>();
    for (const o of applyOps(obs(f.key), f.ops)) m.set(o.date.slice(0, 7), o.value);
    return m;
  });
  const allMonths = [...new Set(byFeature.flatMap((m) => [...m.keys()]))].sort();
  const months = allMonths.filter((mo) => byFeature.every((m) => m.has(mo)));
  if (!months.length) {
    console.error("No overlapping months across predictors — backfill more history.");
    process.exit(1);
  }

  const lastLabeled = monthIndex(usrecLastMonth) - HORIZON;
  const X: number[][] = [];
  const y: number[] = [];
  const keptMonths: string[] = [];
  for (const mo of months) {
    if (inRec.has(mo)) continue; // transition model: only predict ENTRY
    if (postRecShadow.has(mo)) continue; // signals unwind slowly post-recession
    if (monthIndex(mo) > lastLabeled) continue; // outcome unknown
    X.push(byFeature.map((m) => m.get(mo)!));
    let hit = 0;
    for (let h = 1; h <= HORIZON; h++) {
      if (startSet.has(monthAdd(mo, h))) {
        hit = 1;
        break;
      }
    }
    y.push(hit);
    keptMonths.push(mo);
  }

  const nRec = y.reduce((s, v) => s + v, 0);
  console.log(`Sample: ${keptMonths[0]}..${keptMonths[keptMonths.length - 1]}, n=${X.length} expansion months, ${nRec} followed by recession start within ${HORIZON}m`);
  console.log("(recession months excluded — model predicts entry, not persistence)\n");

  const fit = fitLogit(X, y);
  const probs = X.map((row) => predictProb(fit.betaStd, fit.means, fit.stds, row));

  console.log(`${pad("predictor", 20)} ${pad("mean", 10)} ${pad("std", 10)} ${pad("coef(std)", 10)} coef(raw)`);
  console.log("-".repeat(66));
  FEATURES.forEach((f, j) => {
    console.log(
      `${pad(f.name, 20)} ${pad(fit.means[j].toFixed(3), 10)} ${pad(fit.stds[j].toFixed(3), 10)} ` +
        `${pad(fit.betaStd[j + 1].toFixed(3), 10)} ${fit.betaRaw[j + 1].toFixed(5)}`,
    );
  });
  console.log(`\nintercept(raw): ${fit.betaRaw[0].toFixed(4)}   intercept(std): ${fit.betaStd[0].toFixed(4)}`);
  console.log(`logLik ${fit.logLik.toFixed(1)}  null ${fit.nullLogLik.toFixed(1)}  McFadden R² ${fit.mcfaddenR2.toFixed(3)}  (${fit.iterations} iters)`);

  console.log("\nReliability (in-sample — for sanity only, validate OOS before trusting):");
  console.log(`${pad("pred", 10)} ${pad("n", 6)} ${pad("avg_pred", 9)} empirical`);
  for (const b of reliability(probs, y)) {
    console.log(
      `${pad(`${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`, 10)} ${pad(String(b.n), 6)} ` +
        `${pad(b.avgPred.toFixed(3), 9)} ${b.empirical.toFixed(3)}`,
    );
  }

  console.log("\n# Paste into config/model.yaml if the fit looks sane:");
  console.log("pooled_logit:");
  console.log(`  horizon_months: ${HORIZON}`);
  console.log(`  sample: "${keptMonths[0]}..${keptMonths[keptMonths.length - 1]}"`);
  console.log("  predictors:");
  FEATURES.forEach((f, j) => {
    const ops = f.ops
      .map((op) => (op.n !== undefined ? `{ t: ${op.t}, n: ${op.n} }` : `{ t: ${op.t} }`))
      .join(", ");
    console.log(
      `    - { name: ${f.name}, key: ${f.key}, ops: [${ops}], mean: ${fit.means[j].toFixed(6)}, std: ${fit.stds[j].toFixed(6)}, coef: ${fit.betaStd[j + 1].toFixed(6)} }`,
    );
  });
  console.log(`  intercept: ${fit.betaStd[0].toFixed(6)}`);
}

main();
