import cron from "node-cron";
import { getConfig } from "../config/load.js";
import { jobFetch } from "./fetch.js";
import { jobCheckSignals } from "./checkSignals.js";
import { jobDigest } from "./digest.js";
import { jobExpireSubscriptions } from "./subscriptions.js";
import { processDeliveries } from "../publish/publisher.js";

const wrap = (name: string, fn: () => Promise<void>) => async () => {
  try {
    await fn();
  } catch (err) {
    console.error(`[${name}] failed:`, err);
  }
};

export function startScheduler(): void {
  const tz = getConfig().env.timezone;
  const digestUtc = getConfig().channels.defaults.digest_time_utc; // "HH:MM"
  const [dh, dm] = digestUtc.split(":");

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

  // Daily digest for digest-mode users
  cron.schedule(`${Number(dm)} ${Number(dh)} * * *`, wrap("digest", jobDigest), { timezone: tz });

  // Retry failed deliveries every 15 min
  cron.schedule("*/15 * * * *", wrap("deliveries", async () => {
    await processDeliveries();
  }), { timezone: tz });

  // Subscription expiry — hourly
  cron.schedule("5 * * * *", wrap("subs", jobExpireSubscriptions), { timezone: tz });

  console.log(`Scheduler started (tz=${tz})`);
}
