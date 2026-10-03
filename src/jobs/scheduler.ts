import cron from "node-cron";
import { getConfig } from "../config/load.js";
import { jobFetch } from "./fetch.js";
import { jobCheckSignals } from "./checkSignals.js";
import { jobDigest, jobDigestAuto, jobCustomDigests } from "./digest.js";
import { jobExpireSubscriptions } from "./subscriptions.js";
import { jobHealthcheck } from "./health.js";
import { jobBackup } from "./backup.js";
import { processDeliveries } from "../publish/publisher.js";

const wrap = (name: string, fn: () => Promise<void>) => async () => {
  try {
    await fn();
  } catch (err) {
    console.error(`[${name}] failed:`, err);
  }
};

export function startScheduler(): void {
  // All configured times are UTC (config keys say *_utc) — pin the timezone
  // explicitly so TIMEZONE env can't shift the documented schedule.
  const tz = "UTC";
  const defs = getConfig().channels.defaults;
  const digestUtc = defs.digest_time_utc; // "HH:MM"
  const [dh, dm] = digestUtc.split(":");
  const [wh, wm] = defs.weekly_digest_time_utc.split(":");

  // Daily series: after FRED morning refresh and again in the evening UTC
  cron.schedule("15 14,21 * * *", wrap("daily", async () => {
    await jobFetch("daily");
    await jobCheckSignals(true);
  }), { timezone: tz });

  // Weekly series (ICSA/CCSA Thu, NFCI Wed): run Wed+Thu+Fri to catch lag
  cron.schedule("20 15 * * 3,4,5", wrap("weekly", async () => {
    await jobFetch("weekly");
    await jobCheckSignals(true);
  }), { timezone: tz });

  // Monthly/quarterly series: several days a month to catch release lag
  cron.schedule("30 15 2,7,12,17,22,27 * *", wrap("monthly", async () => {
    await jobFetch("monthly");
    await jobFetch("quarterly");
    await jobCheckSignals(true);
  }), { timezone: tz });

  // Daily digest for channels + users (+ weekly when it falls on this slot)
  cron.schedule(`${Number(dm)} ${Number(dh)} * * *`, wrap("digest", jobDigestAuto), { timezone: tz });

  // Weekly digest on its configured weekday/time (covers weekly_time > daily_time)
  cron.schedule(
    `${Number(wm)} ${Number(wh)} * * ${defs.weekly_digest_day_utc}`,
    wrap("digest-weekly", async () => jobDigest("weekly")),
    { timezone: tz },
  );

  // Plus users with a custom digest_time — checked every 15 min (dedup-safe)
  cron.schedule("*/15 * * * *", wrap("digest-custom", jobCustomDigests), { timezone: tz });

  // Retry failed deliveries every 15 min
  cron.schedule("*/15 * * * *", wrap("deliveries", async () => {
    await processDeliveries();
  }), { timezone: tz });

  // Subscription expiry — hourly
  cron.schedule("5 * * * *", wrap("subs", jobExpireSubscriptions), { timezone: tz });

  // Healthcheck — daily 06:00 (DMs admin on issues)
  cron.schedule("0 6 * * *", wrap("health", jobHealthcheck), { timezone: tz });

  // SQLite backup — Sunday 03:30, keeps last 14
  cron.schedule("30 3 * * 0", wrap("backup", async () => { await jobBackup(); }), { timezone: tz });

  console.log(`Scheduler started (tz=${tz})`);
}
