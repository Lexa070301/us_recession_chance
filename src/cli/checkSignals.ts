import "dotenv/config";
import { jobCheckSignals } from "../jobs/checkSignals.js";
import { getDb } from "../data/db.js";

// Usage: tsx src/cli/checkSignals.ts [--publish]
const publish = process.argv.includes("--publish");

async function main() {
  getDb();
  await jobCheckSignals(publish);
}

main();
