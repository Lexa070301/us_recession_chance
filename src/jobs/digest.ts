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

/** Daily digest: events of last 24h + active signals + composite, per locale. */
export async function jobDigest(): Promise<void> {
  const db = getDb();
  const cfg = getConfig();
  console.log(`[digest] building — ${new Date().toISOString()}`);

  const events = getRecentEvents(24, db);
  const states = getAllSignalStates(db);
  const composite = computeComposite(
    new Map(states.map((s) => [s.signal_key, s])),
    cfg.signals,
  );
  const today = new Date().toISOString().slice(0, 10);

  const locales = new Set<string>([cfg.channels.defaults.fallback_locale]);
  for (const ch of getChannelTargets()) locales.add(ch.locale);
  for (const u of listActiveUsers(db)) locales.add(u.locale);

  const texts = new Map<string, string>();
  for (const loc of locales) texts.set(loc, renderDigest(events, states, composite, loc, today));

  let enqueued = 0;
  for (const ch of getChannelTargets()) {
    enqueueDelivery(
      { digestKey: today, targetType: "channel", targetId: ch.chatId, locale: ch.locale, payloadText: texts.get(ch.locale)! },
      db,
    );
    enqueued++;
  }
  for (const user of listActiveUsers(db)) {
    const prefs = getPrefs(user.tg_user_id, db);
    if (prefs.delivery_mode !== "digest") continue;
    const loc = user.locale;
    enqueueDelivery(
      { digestKey: today, targetType: "dm", targetId: String(user.tg_user_id), locale: loc, payloadText: texts.get(loc) ?? texts.get(cfg.channels.defaults.fallback_locale)! },
      db,
    );
    enqueued++;
  }

  const res = await processDeliveries(db);
  console.log(`[digest] enqueued=${enqueued} sent=${res.sent} failed=${res.failed}`);
}
