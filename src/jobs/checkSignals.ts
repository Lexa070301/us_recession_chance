import { runEngine } from "../signals/engine.js";
import { processDeliveries, routeBucketAlert, routeCompositeAlerts, routeEvents } from "../publish/publisher.js";

/**
 * Evaluate signals, route new events, flush pending deliveries.
 * `publish=false` = dry run (console only).
 */
export async function jobCheckSignals(publish = true): Promise<void> {
  console.log(`[signals] evaluating — ${new Date().toISOString()}`);
  const { events, composite, prevScore, prevBucket, evaluated, skipped } = runEngine();
  console.log(
    `[signals] evaluated=${evaluated} skipped=${skipped} transitions=${events.length} score=${composite.score} (${composite.bucket})`,
  );
  for (const ev of events) {
    console.log(`  ${ev.signal_key}: ${ev.from_state} -> ${ev.to_state} (value=${ev.value})`);
  }
  if (!publish) return;
  let enqueued = routeCompositeAlerts(prevScore, composite);
  if (enqueued) console.log(`[signals] enqueued ${enqueued} score-threshold alerts`);
  enqueued = routeBucketAlert(prevBucket, composite);
  if (enqueued) console.log(`[signals] enqueued ${enqueued} band-change alerts`);
  if (events.length) {
    enqueued += routeEvents(events, composite);
    console.log(`[signals] enqueued ${enqueued} deliveries total`);
  }
  const res = await processDeliveries();
  if (res.sent || res.failed) console.log(`[deliveries] sent=${res.sent} failed=${res.failed}`);
}
