import { getConfig, getChannelTargets } from "../config/load.js";
import { getDb } from "../data/db.js";
import {
  getAllSignalStates,
  getCompositeAtOrBefore,
  getRecentEvents,
} from "../data/repositories/signalState.js";
import { enqueueDelivery } from "../data/repositories/deliveries.js";
import { cardAlreadySent, markCardSent } from "../data/repositories/cards.js";
import { getPrefs, listActiveUsers } from "../data/repositories/users.js";
import { processDeliveries } from "../publish/publisher.js";
import { sendTelegramPhoto } from "../publish/adapters/telegram.js";
import { renderDigest, renderWeeklyDashboard } from "../publish/render/templates.js";
import { getSyndicationUrl } from "../publish/syndication/repo.js";
import { computeComposite } from "../signals/score.js";
import { computePooledProb } from "../signals/pooledProb.js";
import { collectCardData, trendScores } from "../card/data.js";
import { renderCard } from "../card/render.js";
import { syndicatePosts } from "../publish/syndication/index.js";
import { t } from "../publish/render/i18n.js";

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

  // Photo-first (PLAN2 §4/5): weekly digest card before the text post.
  // Photos bypass the text-only outbox; dedup via card_sent_keys and
  // per-channel isolation — a card failure never blocks the text digest.
  // DM cards are out of scope for v1.
  if (kind === "weekly" && process.env.CARD_ENABLED === "true") {
    for (const ch of getChannelTargets()) {
      if (cardAlreadySent(key, ch.chatId, db)) continue;
      try {
        const data = collectCardData(ch.locale, db);
        const png = await renderCard(data);
        await sendTelegramPhoto(ch.chatId, png, data.caption);
        markCardSent(key, ch.chatId, db);
      } catch (err) {
        console.error(`[digest] card for ${ch.id} failed (text unaffected):`, err);
      }
    }
  }

  const locales = new Set<string>([cfg.channels.defaults.fallback_locale]);
  for (const ch of getChannelTargets()) locales.add(ch.locale);
  for (const u of listActiveUsers(db)) locales.add(u.locale);
  const fb = cfg.channels.defaults.fallback_locale;
  const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");
  const siteLink = (loc: string) =>
    siteUrl ? `${siteUrl}${loc === fb ? "" : `/${loc}`}` : undefined;

  const isWeekly = kind === "weekly";
  const trend = isWeekly ? trendScores(90, db) : [];
  // WoW delta — cutoff formatted like composite_snapshots.ts writes it.
  const prevScore = isWeekly
    ? (getCompositeAtOrBefore(
        new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19).replace("T", " "),
        db,
      )?.score ?? null)
    : null;

  const renderFor = (loc: string, withPromo: boolean, links: { telegraph?: string } = {}) =>
    isWeekly
      ? renderWeeklyDashboard(
          events, states, composite, trend, prevScore, loc, dateLabel,
          { site: siteLink(loc), telegraph: links.telegraph },
          withPromo ? promo : undefined,
        )
      : renderDigest(events, states, composite, loc, dateLabel, kind, withPromo ? promo : undefined);

  // Weekly dashboard (PLAN2 §5): Telegraph pages go FIRST so the channel
  // post can carry "read more" links. Other venues publish after the text.
  if (isWeekly && process.env.SYNDICATION_ENABLED === "true") {
    const prePosts = [...locales].map((loc) => ({
      key,
      kind: "weekly" as const,
      locale: loc,
      title: `${t(loc, "weekly.title", { week: dateLabel })}`,
      text: renderFor(loc, false),
      url: siteLink(loc),
    }));
    await syndicatePosts(prePosts, db, ["telegraph"]);
  }

  const channelTexts = new Map<string, string>();
  const userTexts = new Map<string, string>();
  for (const loc of locales) {
    const telegraph = isWeekly ? getSyndicationUrl("telegraph", loc, key, db) : undefined;
    channelTexts.set(loc, renderFor(loc, true, { telegraph }));
    userTexts.set(loc, renderFor(loc, false, { telegraph }));
  }

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

  // External venues (PLAN2 §3): SYNDICATION_ENABLED is set only in the GHA
  // publishing environment — the server lacks the secrets, so even a bug
  // can't double-post. Per-venue failures are isolated and fail-open.
  if (process.env.SYNDICATION_ENABLED === "true") {
    const posts = [...channelTexts.entries()].map(([loc, text]) => ({
      key,
      kind,
      locale: loc,
      title: text.split("\n")[0],
      text,
      url: siteLink(loc),
    }));
    const syn = await syndicatePosts(posts, db);
    console.log(`[digest] syndication published=${syn.published} skipped=${syn.skipped} failed=${syn.failed}`);
  }
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
  const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");
  const texts = new Map<string, string>();

  // Weekly for custom-time users is the SAME dashboard render as channels —
  // sparkline, WoW delta and read-more links included (PLAN2 §5).
  const renderFor = (kind: DigestKind, loc: string, key: string) => {
    if (kind !== "weekly") return renderDigest(events, states, composite, loc, key.slice(2), kind);
    return renderWeeklyDashboard(
      getRecentEvents(168, db),
      states,
      composite,
      trendScores(90, db),
      getCompositeAtOrBefore(
        new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19).replace("T", " "),
        db,
      )?.score ?? null,
      loc,
      key.slice(2),
      {
        site: siteUrl ? `${siteUrl}${loc === fb ? "" : `/${loc}`}` : undefined,
        telegraph: getSyndicationUrl("telegraph", loc, key, db),
      },
    );
  };

  let enqueued = 0;
  for (const { user, kind } of due) {
    const key = digestKey(kind, now);
    const loc = user.locale;
    if (!texts.has(`${loc}:${kind}`)) {
      texts.set(`${loc}:${kind}`, renderFor(kind, loc, key));
    }
    enqueued += enqueueDelivery(
      {
        digestKey: key,
        targetType: "dm",
        targetId: String(user.tg_user_id),
        locale: loc,
        payloadText: texts.get(`${loc}:${kind}`) ?? renderFor(kind, fb, key),
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
export async function jobDigestAuto(opts?: { weekly?: "auto" | "force" }): Promise<void> {
  const cfg = getConfig();
  const now = new Date();
  const [wh, wm] = cfg.channels.defaults.weekly_digest_time_utc.split(":").map(Number);
  const weeklyDue =
    now.getUTCDay() === cfg.channels.defaults.weekly_digest_day_utc &&
    (opts?.weekly === "force" ||
      now.getUTCHours() * 60 + now.getUTCMinutes() >= wh * 60 + wm);
  await jobDigest("daily");
  if (weeklyDue) {
    await jobDigest("weekly");
    // Self-audit after the weekly digest — internally gated to the
    // publication environment (SYNDICATION_ENABLED) so the server never
    // double-posts (PLAN2 §6).
    const { jobSelfAudit } = await import("./selfAudit.js");
    await jobSelfAudit();
  }
}
