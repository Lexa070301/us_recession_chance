import {
  expireDueSubscriptions,
  listExpiringSubscriptions,
  markExpiryReminded,
} from "../data/repositories/subscriptions.js";
import { getUser } from "../data/repositories/users.js";
import { sendTelegramMessage } from "../publish/adapters/telegram.js";
import { t } from "../publish/render/i18n.js";

/** One DM ~72h before Plus expiry — silent expiry costs renewals. */
export async function jobRenewalReminders(): Promise<void> {
  const expiring = listExpiringSubscriptions(72);
  if (!expiring.length) return;
  console.log(`[subs] renewal reminders: ${expiring.map((e) => e.user_id).join(", ")}`);
  for (const { user_id, expires_at } of expiring) {
    try {
      const locale = getUser(user_id)?.locale ?? "en";
      const msLeft = Date.parse(`${expires_at.replace(" ", "T")}Z`) - Date.now();
      const days = Math.max(1, Math.ceil(msLeft / 864e5));
      await sendTelegramMessage(
        user_id,
        t(locale, "bot.plan_expiring", { until: expires_at.slice(0, 10), days }),
      );
      markExpiryReminded(user_id);
    } catch (err) {
      console.error(`[subs] reminder ${user_id} failed: ${err}`);
    }
  }
}

/** Expire overdue subscriptions and notify users. */
export async function jobExpireSubscriptions(): Promise<void> {
  const expired = expireDueSubscriptions();
  if (!expired.length) return;
  console.log(`[subs] expired: ${expired.join(", ")}`);
  for (const userId of expired) {
    try {
      const locale = getUser(userId)?.locale ?? "en";
      await sendTelegramMessage(userId, t(locale, "bot.plan_expired"));
    } catch (err) {
      console.error(`[subs] notify ${userId} failed: ${err}`);
    }
  }
}
