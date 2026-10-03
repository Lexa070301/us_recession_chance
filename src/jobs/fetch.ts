import { fetchAllSeries } from "../data/fredClient.js";
import type { Frequency } from "../config/schema.js";

export async function jobFetch(frequency?: Frequency): Promise<void> {
  const label = frequency ?? "all";
  console.log(`[fetch] ${label} — ${new Date().toISOString()}`);
  const summary = await fetchAllSeries({ frequency });
  const errors = Object.entries(summary.errors);
  console.log(`[fetch] ${label}: ${summary.total} rows across ${Object.keys(summary.series).length} series`);
  for (const [k, e] of errors) console.error(`[fetch] ${k}: ${e}`);
}
