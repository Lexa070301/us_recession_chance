import type Database from "better-sqlite3";
import { getConfig, getSignalDef } from "../config/load.js";
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
import { getPrefs, listActiveUsers, quietHoursUntil, setBlocked } from "../data/repositories/users.js";
import type { CompositeResult } from "../signals/score.js";
import { sendTelegramMessage } from "./adapters/telegram.js";
import { renderBucketAlert, renderCompositeAlert, renderSignalEvent } from "./render/templates.js";

/**
 * Route a SignalEvent to Plus users' DMs. Channels are digest-only now —
 * instant transitions are a paid bot feature (see plans in model.yaml).
 * Free/digest-mode users get events folded into their digests instead.
 */
export function routeEvent(
  event: SignalEventRow,
  composite: CompositeResult,
  conn?: Database.Database,
): number {
  const db = conn ?? getDb();
  const model = getConfig().model;
  let enqueued = 0;

  const newSeverity = SEVERITY_ORDER[event.to_state];
  const severityUp = newSeverity > SEVERITY_ORDER[event.from_state];
  const isNowcast = getSignalDef(event.signal_key)?.block === "nowcast";

  for (const user of listActiveUsers(db)) {
    if (user.plan !== "plus") continue;
    const prefs = getPrefs(user.tg_user_id, db);
    if (prefs.delivery_mode !== "instant") continue;
    if (isNowcast ? !prefs.nowcast_alerts : prefs.enabled_signals && !prefs.enabled_signals.includes(event.signal_key)) {
      continue;
    }

    const floor = Math.max(
      SEVERITY_ORDER[prefs.min_severity],
      SEVERITY_ORDER[model.plans.plus.min_severity_floor],
    );

    // only escalate-or-new events are pushed instantly; downgrades go to digest
    const relevant =
      (severityUp && newSeverity >= floor) ||
      (event.to_state === "ok" && SEVERITY_ORDER[event.from_state] >= floor);
    if (!relevant) continue;

    // Quiet hours: defer non-critical alerts to the window end (user's TZ).
    const notBefore =
      event.to_state === "critical"
        ? undefined
        : quietHoursUntil(prefs.quiet_hours, undefined, prefs.tz_offset) ?? undefined;
    const text = renderSignalEvent(event, composite, user.locale);
    enqueueDelivery(
      { eventId: event.id, targetType: "dm", targetId: String(user.tg_user_id), locale: user.locale, payloadText: text, notBefore },
      db,
    );
    enqueued++;
  }
  return enqueued;
}

/**
 * Plus feature: DM users whose personal score threshold was crossed upward
 * by the latest composite. Fires once per crossing — while the score stays
 * above the threshold, prevScore >= threshold suppresses repeats.
 */
export function routeCompositeAlerts(
  prevScore: number | null,
  composite: CompositeResult,
  conn?: Database.Database,
): number {
  if (prevScore === null) return 0;
  const db = conn ?? getDb();
  let enqueued = 0;
  for (const user of listActiveUsers(db)) {
    if (user.plan !== "plus") continue;
    const prefs = getPrefs(user.tg_user_id, db);
    const t = prefs.score_threshold;
    if (t === null || t === undefined) continue;
    if (prevScore >= t || composite.score < t) continue;
    enqueueDelivery(
      {
        targetType: "dm",
        targetId: String(user.tg_user_id),
        locale: user.locale,
        payloadText: renderCompositeAlert(composite, t, user.locale),
        notBefore: quietNotBefore(prefs, composite),
      },
      db,
    );
    enqueued++;
  }
  return enqueued;
}

/** Quiet-hours rule for composite-level alerts: defer unless the new band is high/severe. */
function quietNotBefore(
  prefs: { quiet_hours: { from: number; to: number } | null; tz_offset: number },
  composite: CompositeResult,
): string | undefined {
  if (composite.bucket === "high" || composite.bucket === "severe") return undefined;
  return quietHoursUntil(prefs.quiet_hours, undefined, prefs.tz_offset) ?? undefined;
}

/**
 * Plus feature: the composite risk BAND changed (e.g. low → elevated).
 * Fires in both directions — a de-escalation is information too. Goes to
 * all Plus users regardless of delivery_mode: band changes are the
 * product's headline answer and arrive days/weeks apart, not noise.
 */
export function routeBucketAlert(
  prevBucket: string | null,
  composite: CompositeResult,
  conn?: Database.Database,
): number {
  if (!prevBucket || prevBucket === composite.bucket) return 0;
  const db = conn ?? getDb();
  let enqueued = 0;
  for (const user of listActiveUsers(db)) {
    if (user.plan !== "plus") continue;
    const prefs = getPrefs(user.tg_user_id, db);
    enqueueDelivery(
      {
        targetType: "dm",
        targetId: String(user.tg_user_id),
        locale: user.locale,
        payloadText: renderBucketAlert(prevBucket, composite, user.locale),
        notBefore: quietNotBefore(prefs, composite),
      },
      db,
    );
    enqueued++;
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
      await sendTelegramMessage(d.target_id, d.payload_text, d.link_preview_url ?? undefined);
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
