import type Database from "better-sqlite3";
import { getChannelTargets, getConfig } from "../config/load.js";
import { getDb } from "../data/db.js";
import {
  enqueueDelivery,
  markFailed,
  markSent,
  pendingDeliveries,
  retryableDeliveries,
} from "../data/repositories/deliveries.js";
import type { SignalEventRow } from "../data/repositories/signalState.js";
import { SEVERITY_ORDER } from "../data/repositories/signalState.js";
import { getPrefs, listActiveUsers, setBlocked } from "../data/repositories/users.js";
import type { CompositeResult } from "../signals/score.js";
import { sendTelegramMessage } from "./adapters/telegram.js";
import { renderSignalEvent } from "./render/templates.js";

/**
 * Route a SignalEvent to delivery targets and enqueue them:
 *  - every configured channel (one render per locale)
 *  - every active user whose prefs allow it and whose delivery_mode = instant
 * Digest-mode users are handled by the digest job instead.
 */
export function routeEvent(
  event: SignalEventRow,
  composite: CompositeResult,
  conn?: Database.Database,
): number {
  const db = conn ?? getDb();
  const model = getConfig().model;
  let enqueued = 0;

  for (const ch of getChannelTargets()) {
    const text = renderSignalEvent(event, composite, ch.locale);
    enqueueDelivery(
      { eventId: event.id, targetType: "channel", targetId: ch.chatId, locale: ch.locale, payloadText: text },
      db,
    );
    enqueued++;
  }

  const newSeverity = SEVERITY_ORDER[event.to_state];
  const severityUp = newSeverity > SEVERITY_ORDER[event.from_state];

  for (const user of listActiveUsers(db)) {
    const prefs = getPrefs(user.tg_user_id, db);
    if (prefs.enabled_signals && !prefs.enabled_signals.includes(event.signal_key)) continue;

    // free users can't go below the plan floor; plus users use their own pref
    const floor =
      user.plan === "plus"
        ? SEVERITY_ORDER[prefs.min_severity]
        : Math.max(SEVERITY_ORDER[prefs.min_severity], SEVERITY_ORDER[model.plans.free.min_severity_floor]);

    // only escalate-or-new events are pushed instantly; downgrades go to digest
    const relevant =
      (severityUp && newSeverity >= floor) ||
      (event.to_state === "ok" && SEVERITY_ORDER[event.from_state] >= floor);
    if (!relevant) continue;

    if (prefs.delivery_mode === "instant") {
      const text = renderSignalEvent(event, composite, user.locale);
      enqueueDelivery(
        { eventId: event.id, targetType: "dm", targetId: String(user.tg_user_id), locale: user.locale, payloadText: text },
        db,
      );
      enqueued++;
    }
  }
  return enqueued;
}

export function routeEvents(events: SignalEventRow[], composite: CompositeResult, conn?: Database.Database): number {
  let n = 0;
  for (const ev of events) n += routeEvent(ev, composite, conn);
  return n;
}

/** Attempt to send all pending deliveries and retry failed ones. */
export async function processDeliveries(conn?: Database.Database): Promise<{ sent: number; failed: number }> {
  const db = conn ?? getDb();
  const queue = [...pendingDeliveries(200, db), ...retryableDeliveries(5, 200, db)];
  let sent = 0;
  let failed = 0;

  for (const d of queue) {
    try {
      if (!d.payload_text) throw new Error("empty payload_text");
      await sendTelegramMessage(d.target_id, d.payload_text);
      markSent(d.id, db);
      sent++;
    } catch (err) {
      markFailed(d.id, String(err), db);
      failed++;
      const msg = String(err);
      if (d.target_type === "dm" && (msg.includes("bot was blocked") || msg.includes("user is deactivated") || msg.includes("403"))) {
        setBlocked(Number(d.target_id), true, db);
      }
    }
  }
  return { sent, failed };
}
