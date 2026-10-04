import "dotenv/config";
import { getConfig } from "../config/load.js";
import { getDb } from "../data/db.js";
import { FredClient } from "../data/fredClient.js";
import { getVintageDates } from "../data/repositories/observations.js";

/**
 * ALFRED vintage backfill (PLAN2 §1). For each series with `vintage: alfred`
 * in sources.yaml, downloads the full revision history ("what was known on
 * date D") into observations.vintage_date — the foundation for true
 * no-look-ahead backtests (`npm run backtest -- --vintage`).
 *
 * IMPORTANT — FRED vintage_dates semantics (verified empirically): a batch
 * request behaves as a realtime RANGE. The response is a baseline snapshot
 * at the earliest requested vintage plus delta rows for EVERY actual vintage
 * in the range — each tagged with its true realtime_start, requested or not.
 * Stored rows are therefore deltas (series, date, vintage_became_valid) and
 * as-of reads reconstruct per-date latest value (see observationsAsOf).
 * Full revision history is cheap: a whole series is ~1–7k delta rows.
 *
 * Vintage dates come from fred/series/vintagedates — real release dates —
 * chunked into ranges only to bound response size. Incremental: ranges
 * already covered by stored vintages are skipped.
 *
 * This is a backtest-environment operation, NOT part of the production
 * scheduler: vintages only serve analysis and would bloat the GHA cache/backups.
 *
 * Usage: npm run vintages [-- --series unrate]
 */

/** Real vintage dates per request — bounds response size, not resolution. */
const CHUNK = 150;

const minusYears = (date: string, years: number): string =>
  `${Number(date.slice(0, 4)) - years}${date.slice(4)}`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--series") ? args[args.indexOf("--series") + 1] : undefined;
  const cfg = getConfig();
  const db = getDb();
  const client = new FredClient();

  const defs = cfg.sources.series.filter(
    (s) => s.source === "fred" && s.vintage !== "none" && (!only || s.key === only),
  );
  if (!defs.length) {
    console.log(
      only
        ? `No vintage-enabled series matches "${only}".`
        : "No vintage-enabled series in sources.yaml.",
    );
    return;
  }

  for (const def of defs) {
    console.log(
      `\n${def.key} (${def.series_id}) — ALFRED backfill, lookback ${def.vintage_lookback_years}y`,
    );

    let all: string[];
    try {
      all = await client.fetchVintageDates(def.series_id!);
    } catch (err) {
      console.error(`  vintagedates failed: ${err}`);
      continue;
    }

    const have = new Set(getVintageDates(def.key, db));
    const missing = all.filter((d) => !have.has(d));
    console.log(`  ${all.length} real vintages, ${have.size} stored, ${missing.length} to fetch`);

    for (let i = 0; i < missing.length; i += CHUNK) {
      const batch = missing.slice(i, i + CHUNK);
      // obsStart bounds the baseline snapshot at the batch's first vintage;
      // delta rows after it are unaffected (they're new obs by definition).
      const obsStart = minusYears(batch[0], def.vintage_lookback_years);
      try {
        const res = await client.fetchVintageBatch(def.key, batch, { obsStart });
        const total = res.reduce((s, r) => s + r.rows, 0);
        console.log(
          `  batch ${Math.floor(i / CHUNK) + 1}: ${batch[0]}..${batch[batch.length - 1]} ` +
            `→ ${res.length} vintage rows, ${total} obs`,
        );
      } catch (err) {
        console.error(`  batch starting ${batch[0]} failed: ${err}`);
      }
    }
  }
}

await main();
