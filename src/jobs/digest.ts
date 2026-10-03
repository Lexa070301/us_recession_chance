import { getConfig, getChannelTargets } from "../config/load.js";
import { getDb } from "../data/db.js";
import {
  getAllSignalStates,
  getRecentEvents,
} from "../data/repositories/signalState.js";
import { enqueueDelivery } from "../data/repositories/deliveries.js";
import { getPrefs, listActiveUsers } from "../data/repositories/users.js";
import { processDeliveries } from "../publish/publisher.js";
import { renderDigest } from "../publish/render/templates.js";
import { computeComposite } from "../signals/score.js";
import { computePooledProb } from "../signals/pooledProb.js";

export type DigestKind = "daily" | "weekly";

/** Dedup keys: d:YYYY-MM-DD / w:YYYY-Www (ISO week). */
export function digestKey(kind: DigestKind, now = new Date()): string {
  if (kind === "daily") return `d:${now.toISOString().slice(0, 10)}`;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // Thursday of this ISO week
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((d.getTime() - jan4.getTime()) / 604800000);
  return `w:${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** "HH:MM" → minutes since midnight UTC; null when unset/invalid. */
export function digestTimeMinutes(digestTime: string | null): number | null {
  if (!digestTime) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(digestTime);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function buildDigestPayload(kind: DigestKind) {
  const db = getDb();
  const cfg = getConfig();
  const events = getRecentEvents(kind === "weekly" ? 168 : 24, db);
  const states = getAllSignalStates(db);
  const composite = computeComposite(
    new Map(states.map((s) => [s.signal_key, s])),
    cfg.signals,
  );
  composite.modelProb = computePooledProb(db);
  return { events, states, composite };
}

/**
 * Send a digest to channels + eligible users at the fixed schedule.
 * Plus users with a custom digest_time are handled by jobCustomDigests.
 */
export async function jobDigest(kind: DigestKind): Promise<void> {
  const db = getDb();
  const cfg = getConfig();
  const now = new Date();
  const key = digestKey(kind, now);
  const dateLabel = key.slice(2);
  const promo = cfg.env.botUsername;
  console.log(`[digest] building ${kind} — ${now.toISOString()}`);

  const { events, states, composite } = buildDigestPayload(kind);

  const locales = new Set<string>([cfg.channels.defaults.fallback_locale]);
  for (const ch of getChannelTargets()) locales.add(ch.locale);
  for (const u of listActiveUsers(db)) locales.add(u.locale);

  const channelTexts = new Map<string, string>();
  const userTexts = new Map<string, string>();
  for (const loc of locales) {
    channelTexts.set(loc, renderDigest(events, states, composite, loc, dateLabel, kind, promo));
    userTexts.set(loc, renderDigest(events, states, composite, loc, dateLabel, kind));
  }
  const fb = cfg.channels.defaults.fallback_locale;

  let enqueued = 0;
  for (const ch of getChannelTargets()) {
    enqueued += enqueueDelivery(
      { digestKey: key, targetType: "channel", targetId: ch.chatId, locale: ch.locale, payloadText: channelTexts.get(ch.locale)! },
      db,
    ) ? 1 : 0;
  }
  for (const user of listActiveUsers(db)) {
    const prefs = getPrefs(user.tg_user_id, db);
    if (user.plan === "plus") {
      // custom-time users get their digest from jobCustomDigests instead
      if (prefs.digest_time) continue;
      if (kind === "daily" ? !prefs.daily_digest : !prefs.weekly_digest) continue;
    }
    const loc = user.locale;
    enqueued += enqueueDelivery(
      { digestKey: key, targetType: "dm", targetId: String(user.tg_user_id), locale: loc, payloadText: userTexts.get(loc) ?? userTexts.get(fb)! },
      db,
    ) ? 1 : 0;
  }

  const res = await processDeliveries(db);
  console.log(`[digest] ${kind} enqueued=${enqueued} sent=${res.sent} failed=${res.failed}`);
}

/**
 * Every-15-min job: Plus users with a custom digest_time get their digest
 * once the UTC clock passes their setting (dedup key makes reruns no-ops).
 */
export async function jobCustomDigests(): Promise<void> {
  const db = getDb();
  const cfg = getConfig();
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const weeklyDue = now.getUTCDay() === cfg.channels.defaults.weekly_digest_day_utc;

  const targets = listActiveUsers(db).filter((u) => u.plan === "plus");
  const due: { user: (typeof targets)[number]; kind: DigestKind }[] = [];
  for (const user of targets) {
    const prefs = getPrefs(user.tg_user_id, db);
    const t = digestTimeMinutes(prefs.digest_time);
    if (t === null || nowMin < t) continue;
    if (prefs.daily_digest) due.push({ user, kind: "daily" });
    if (weeklyDue && prefs.weekly_digest) due.push({ user, kind: "weekly" });
  }
  if (!due.length) return;

  const { events, states, composite } = buildDigestPayload("daily");
  const fb = cfg.channels.defaults.fallback_locale;
  const texts = new Map<string, string>();

  let enqueued = 0;
  for (const { user, kind } of due) {
    const key = digestKey(kind, now);
    const loc = user.locale;
    if (!texts.has(`${loc}:${kind}`)) {
      const wk = kind === "weekly"
        ? { events: getRecentEvents(168, db) }
        : { events };
      texts.set(
        `${loc}:${kind}`,
        renderDigest(wk.events, states, composite, loc, key.slice(2), kind),
      );
    }
    enqueued += enqueueDelivery(
      {
        digestKey: key,
        targetType: "dm",
        targetId: String(user.tg_user_id),
        locale: loc,
        payloadText: texts.get(`${loc}:${kind}`) ?? renderDigest(events, states, composite, fb, key.slice(2), kind),
      },
      db,
    ) ? 1 : 0;
  }
  if (enqueued) {
    const res = await processDeliveries(db);
    console.log(`[digest] custom-time enqueued=${enqueued} sent=${res.sent} failed=${res.failed}`);
  }
}

/**
 * What the scheduled slot should send right now: daily always; weekly when
 * today is the configured weekly day and its time has come. Used by the
 * fixed-time cron and by the GitHub Actions run.
 */
export async function jobDigestAuto(): Promise<void> {
  const cfg = getConfig();
  const now = new Date();
  const [wh, wm] = cfg.channels.defaults.weekly_digest_time_utc.split(":").map(Number);
  const weeklyDue =
    now.getUTCDay() === cfg.channels.defaults.weekly_digest_day_utc &&
    now.getUTCHours() * 60 + now.getUTCMinutes() >= wh * 60 + wm;
  await jobDigest("daily");
  if (weeklyDue) await jobDigest("weekly");
}
