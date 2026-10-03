import "dotenv/config";
import { getConfig } from "../config/load.js";
import { getDb } from "../data/db.js";
import {
  activateSubscription,
  applyRefund,
  getSubscription,
  recordPayment,
  type PaymentRow,
} from "../data/repositories/subscriptions.js";
import { getPrefs, getUser, savePrefs, upsertUser } from "../data/repositories/users.js";

// Dev-only subscription lifecycle — no Telegram involved.
//   npm run devsub -- grant <tg_user_id> [days]  synthetic payment + activate Plus
//   npm run devsub -- refund <charge_id>        refund bookkeeping (DB only, no API)
//   npm run devsub -- expire <tg_user_id>       expire NOW (then run the expiry job)
//   npm run devsub -- status <tg_user_id>       show plan, subscription, payments

const [cmd, arg1, arg2] = process.argv.slice(2);

function grant(userId: number, days: number): void {
  upsertUser(userId, null, "en");
  const chargeId = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tier =
    getConfig().model.subscription.tiers.find((t) => t.days === 30) ??
    getConfig().model.subscription.tiers[0];
  recordPayment(chargeId, userId, tier?.stars ?? 0, days);
  activateSubscription(userId, days, chargeId);
  savePrefs(userId, { delivery_mode: "instant" }); // mirrors onSuccessfulPayment
  console.log(`Granted Plus: user=${userId} days=${days} charge_id=${chargeId}`);
}

function refund(chargeId: string): void {
  const res = applyRefund(chargeId);
  if (res === "unknown") console.error(`No payment ${chargeId}`);
  else if (res === "already_refunded") console.log(`Already refunded: ${chargeId}`);
  else console.log(`Refunded ${chargeId} — expires_at=${res.expiresAt ?? "canceled"}`);
}

function expire(userId: number): void {
  const n = getDb()
    .prepare(
      `UPDATE subscriptions SET expires_at = datetime('now', '-1 second')
       WHERE user_id = ? AND status = 'active'`,
    )
    .run(userId).changes;
  if (!n) {
    console.error(`No active subscription for ${userId}`);
    return;
  }
  console.log(`Marked expired. Run the expiry job to finish the downgrade:`);
  console.log(`  npx tsx -e "import 'dotenv/config'; import { jobExpireSubscriptions } from './src/jobs/subscriptions.ts'; jobExpireSubscriptions()"`);
}

function status(userId: number): void {
  const user = getUser(userId);
  if (!user) {
    console.error(`Unknown user ${userId}`);
    return;
  }
  const payments = getDb()
    .prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY paid_at DESC")
    .all(userId) as PaymentRow[];
  console.log(JSON.stringify({ user, prefs: getPrefs(userId), subscription: getSubscription(userId), payments }, null, 2));
}

switch (cmd) {
  case "grant": {
    const userId = Number(arg1);
    if (!userId) break;
    grant(userId, Number(arg2) || 30);
    process.exit(0);
  }
  case "refund":
    if (arg1) {
      refund(arg1);
      process.exit(0);
    }
    break;
  case "expire": {
    const userId = Number(arg1);
    if (!userId) break;
    expire(userId);
    process.exit(0);
  }
  case "status": {
    const userId = Number(arg1);
    if (!userId) break;
    status(userId);
    process.exit(0);
  }
}

console.error(`Usage:
  npm run devsub -- grant <tg_user_id> [days]
  npm run devsub -- refund <charge_id>
  npm run devsub -- expire <tg_user_id>
  npm run devsub -- status <tg_user_id>`);
process.exit(1);
