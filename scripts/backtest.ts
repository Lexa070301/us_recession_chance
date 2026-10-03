import "dotenv/config";
import { getConfig } from "../src/config/load.js";
import { getDb } from "../src/data/db.js";
import { getRecessionPeriods } from "../src/data/nber.js";
import { getObservations } from "../src/data/repositories/observations.js";
import { SeriesCache, monthAdd } from "../src/backtest/replay.js";
import { calibrateBands, compositeScoreGrid, signalBacktest } from "../src/backtest/stats.js";

/**
 * Offline backtest (Phase 5). Replays every signal over stored history with
 * publication-lag awareness, derives episodes, and compares them to NBER
 * recession starts. Then builds a monthly composite-score grid and prints
 * empirical P(recession start within 12m) per configured score band.
 *
 * Requires a populated DB: `npm run backfill -- <years>` first.
 * Caveat: uses latest-vintage data (revisions leak a little); publication
 * lags are approximated per frequency (PUBLISH_LAG_DAYS in replay.ts).
 *
 * Usage: npm run backtest
 */

const pad = (s: string, n: number) => s.padEnd(n);
const fmt = (x: number | null, digits = 2) => (x === null ? "  n/a" : x.toFixed(digits));

function main() {
  const db = getDb();
  const usrec = getObservations("usrec", {}, db);
  if (!usrec.length) {
    console.error("No `usrec` observations — run `npm run backfill -- 60` first.");
    process.exit(1);
  }
  const usrecLastMonth = usrec[usrec.length - 1].date.slice(0, 7);
  const recessions = getRecessionPeriods(db);
  const cfg = getConfig();
  const cache = new SeriesCache(db);

  console.log(`NBER recessions in USREC sample (through ${usrecLastMonth}):`);
  for (const r of recessions) console.log(`  ${r.start} .. ${r.end}`);
  console.log();

  // ---- per-signal episode stats ----
  console.log(
    `${pad("signal", 26)} ${pad("sample", 16)} ${pad("ep", 3)} ${pad("cen", 3)} ${pad("rec", 3)} ` +
      `${pad("prec", 6)} ${pad("recall", 6)} ${pad("lead", 5)}  hist(p/r)`,
  );
  console.log("-".repeat(96));
  for (const sig of cfg.signals) {
    const bt = signalBacktest(sig, cache, recessions, usrecLastMonth);
    const hist =
      sig.hist?.precision !== undefined || sig.hist?.recall !== undefined
        ? `${fmt(sig.hist.precision ?? null)}/${fmt(sig.hist.recall ?? null)}`
        : "-";
    console.log(
      `${pad(sig.key, 26)} ${pad(`${bt.sampleStart}–${bt.sampleEnd}`, 16)} ` +
        `${pad(String(bt.episodes.length - bt.censored), 3)} ${pad(String(bt.censored), 3)} ` +
        `${pad(`${bt.caught}/${bt.recessionsInSample}`, 3)} ` +
        `${pad(fmt(bt.precision), 6)} ${pad(fmt(bt.recall), 6)} ` +
        `${pad(fmt(bt.medianLeadMonths, 0), 5)}  ${hist}`,
    );
    if (sig.hist?.precision !== undefined && bt.precision !== null) {
      const delta = Math.abs(bt.precision - sig.hist.precision);
      if (delta > 0.2) {
        console.log(`    ^ WARNING: measured precision differs from static hist by ${delta.toFixed(2)}`);
      }
    }
  }

  // ---- composite score -> empirical probability ----
  console.log("\nComposite score -> empirical P(recession start within 12m):");
  const grid = compositeScoreGrid(cfg.signals, cache, recessions, usrecLastMonth);
  const rows = calibrateBands(grid);
  console.log(`${pad("band", 10)} ${pad("bucket", 10)} ${pad("n", 5)} ${pad("hits", 5)} ${pad("empirical", 9)}  configured`);
  console.log("-".repeat(64));
  for (const b of rows) {
    console.log(
      `${pad(`${b.min}–${b.max}`, 10)} ${pad(b.bucket, 10)} ${pad(String(b.n), 5)} ` +
        `${pad(String(b.hits), 5)} ${pad(fmt(b.empirical), 9)}  ${b.configured_label}`,
    );
  }
  const valid = grid.filter((r) => r.outcome !== null);
  const base = valid.length ? valid.filter((r) => r.outcome === 1).length / valid.length : null;
  console.log(`\nUnconditional base rate over evaluable months: ${fmt(base)} (n=${valid.length})`);
  console.log("\nNote: empirical bands reflect latest-vintage data + approximate lags;");
  console.log("small bins are noisy — prefer wide prob_label buckets over exact numbers.");
}

main();
