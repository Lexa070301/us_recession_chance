import "dotenv/config";
import { backfillAll } from "../data/fredClient.js";
import { getDb } from "../data/db.js";

// Usage: tsx src/cli/backfill.ts [years=30]
const years = Number(process.argv[2] ?? 30);

async function main() {
  getDb(); // ensure migrations
  console.log(`Backfilling ${years} years of history...`);
  const summary = await backfillAll(years);
  console.log(`Done: ${summary.total} observations across ${Object.keys(summary.series).length} series.`);
  const errs = Object.entries(summary.errors);
  if (errs.length) {
    console.error("Errors:");
    for (const [k, e] of errs) console.error(`  ${k}: ${e}`);
    process.exitCode = 1;
  }
}

main();
