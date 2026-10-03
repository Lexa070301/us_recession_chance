import { expireDueSubscriptions } from "../data/repositories/subscriptions.js";
import { getUser } from "../data/repositories/users.js";
import { sendTelegramMessage } from "../publish/adapters/telegram.js";
import { t } from "../publish/render/i18n.js";

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
