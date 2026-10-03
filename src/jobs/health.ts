import { statSync } from "node:fs";
import { getConfig, getSeriesDef } from "../config/load.js";
import type { Frequency } from "../config/schema.js";
import { getDb } from "../data/db.js";
import type Database from "better-sqlite3";
import { sendTelegramMessage } from "../publish/adapters/telegram.js";

/** Max allowed age of the last successful fetch per frequency. */
const STALE_AFTER_HOURS: Record<Frequency, number> = {
  daily: 60,
  weekly: 24 * 9,
  monthly: 24 * 34,
  quarterly: 24 * 100,
};

const MAX_DELIVERY_ATTEMPTS = 5;

export interface HealthReport {
  lines: string[];
  issues: string[];
}

export function healthReport(conn?: Database.Database): HealthReport {
  const db = conn ?? getDb();
  const cfg = getConfig();
  const lines: string[] = [];
  const issues: string[] = [];

  // 1. fetch freshness per configured series
  const lastFetch = new Map(
    (
      db
        .prepare(
          "SELECT series_key, MAX(ts) AS last_ts FROM fetch_log WHERE status = 'success' GROUP BY series_key",
        )
        .all() as { series_key: string; last_ts: string }[]
    ).map((r) => [r.series_key, r.last_ts]),
  );
  const now = Date.now();
  const stale: string[] = [];
  const neverFetched: string[] = [];
  for (const s of cfg.sources.series.filter((x) => x.source === "fred")) {
    const ts = lastFetch.get(s.key);
    if (!ts) {
      neverFetched.push(s.key);
      continue;
    }
    const ageH = (now - Date.parse(`${ts.replace(" ", "T")}Z`)) / 3_600_000;
    if (ageH > STALE_AFTER_HOURS[s.frequency]) {
      stale.push(`${s.key} (${Math.round(ageH)}h old)`);
    }
  }
  if (neverFetched.length) issues.push(`never fetched: ${neverFetched.join(", ")}`);
  if (stale.length) issues.push(`stale series: ${stale.join(", ")}`);
  lines.push(`series: ${lastFetch.size}/${cfg.sources.series.length} fetched ok`);

  // 2. delivery outbox
  const pending = (db.prepare("SELECT COUNT(*) c FROM deliveries WHERE status = 'pending'").get() as { c: number }).c;
  const dead = (
    db
      .prepare("SELECT COUNT(*) c FROM deliveries WHERE status = 'failed' AND attempts >= ?")
      .get(MAX_DELIVERY_ATTEMPTS) as { c: number }
  ).c;
  lines.push(`deliveries: ${pending} pending, ${dead} dead (>=${MAX_DELIVERY_ATTEMPTS} attempts)`);
  if (pending > 500) issues.push(`delivery backlog: ${pending} pending`);
  if (dead > 0) issues.push(`${dead} deliveries exhausted retries`);

  // 3. engine heartbeat
  const lastComposite = db
    .prepare("SELECT MAX(ts) AS ts FROM composite_snapshots")
    .get() as { ts: string | null };
  lines.push(`last composite snapshot: ${lastComposite.ts ?? "never"}`);

  // 4. users / db size
  const users = (db.prepare("SELECT COUNT(*) c FROM users WHERE is_blocked = 0").get() as { c: number }).c;
  lines.push(`active users: ${users}`);
  try {
    const sizeMb = statSync(cfg.env.databasePath).size / 1_048_576;
    lines.push(`db size: ${sizeMb.toFixed(1)} MB`);
  } catch {
    /* db path may not exist yet in tests */
  }

  return { lines, issues };
}

/** Log a health report; DM the admin (ADMIN_TG_ID) when something is wrong. */
export async function jobHealthcheck(): Promise<void> {
  const { lines, issues } = healthReport();
  console.log(`[health] ${lines.join(" | ")}`);
  if (!issues.length) {
    console.log("[health] all checks passed");
    return;
  }
  console.warn(`[health] ISSUES:\n  - ${issues.join("\n  - ")}`);
  const adminId = process.env.ADMIN_TG_ID;
  if (adminId) {
    try {
      await sendTelegramMessage(adminId, `⚠️ health check:\n• ${issues.join("\n• ")}`);
    } catch (err) {
      console.error(`[health] admin notify failed: ${err}`);
    }
  }
}
