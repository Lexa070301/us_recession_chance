import type { Context } from "grammy";
import { getConfig } from "../config/load.js";
import { activateSubscription, recordPayment } from "../data/repositories/subscriptions.js";
import { savePrefs, getUser } from "../data/repositories/users.js";
import { t } from "../publish/render/i18n.js";

export async function onPreCheckout(ctx: Context): Promise<void> {
  await ctx.answerPreCheckoutQuery(true);
}

export async function onSuccessfulPayment(ctx: Context): Promise<void> {
  const payment = ctx.message?.successful_payment;
  const userId = ctx.from?.id;
  if (!payment || !userId) return;

  const cfg = getConfig().model.subscription;
  const chargeId = payment.telegram_payment_charge_id;

  recordPayment(chargeId, userId, payment.total_amount, cfg.period_days);
  activateSubscription(userId, cfg.period_days, chargeId);
  // upgrade UX: switch to instant delivery by default
  savePrefs(userId, { delivery_mode: "instant" });

  const locale = getUser(userId)?.locale ?? "en";
  const until = new Date(Date.now() + cfg.period_days * 86_400_000).toISOString().slice(0, 10);
  await ctx.reply(t(locale, "bot.plan_thanks", { until }));
}
