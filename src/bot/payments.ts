import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getConfig } from "../config/load.js";
import {
  activateSubscription,
  applyRefund,
  getPaymentByRowid,
  listRefundablePayments,
  recordPayment,
} from "../data/repositories/subscriptions.js";
import { savePrefs, getUser } from "../data/repositories/users.js";
import { t } from "../publish/render/i18n.js";

function locale(ctx: Context): string {
  const id = ctx.from?.id;
  if (!id) return getConfig().channels.defaults.fallback_locale;
  return getUser(id)?.locale ?? getConfig().channels.defaults.fallback_locale;
}

/** Invoice payload: `plus:<days>:<userId>:<ts>` — days selects the tier. */
export function parseInvoicePayload(payload: string): { days: number; userId: number } | null {
  const m = /^plus:(\d+):(\d+):(\d+)$/.exec(payload);
  return m ? { days: Number(m[1]), userId: Number(m[2]) } : null;
}

export function findTier(days: number): { days: number; stars: number } | undefined {
  return getConfig().model.subscription.tiers.find((tier) => tier.days === days);
}

export async function onPreCheckout(ctx: Context): Promise<void> {
  await ctx.answerPreCheckoutQuery(true);
}

export async function onSuccessfulPayment(ctx: Context): Promise<void> {
  const payment = ctx.message?.successful_payment;
  const userId = ctx.from?.id;
  if (!payment || !userId) return;

  // Never trust the client-sent payload: resolve the tier ourselves and
  // require the charged amount to match the configured price.
  const parsed = parseInvoicePayload(payment.invoice_payload);
  const tier = parsed ? findTier(parsed.days) : undefined;
  if (
    !parsed ||
    parsed.userId !== userId ||
    !tier ||
    payment.total_amount !== tier.stars ||
    payment.currency !== "XTR"
  ) {
    console.error("unexpected successful_payment:", JSON.stringify(payment));
    return;
  }

  const chargeId = payment.telegram_payment_charge_id;
  const isNew = recordPayment(chargeId, userId, tier.stars, tier.days);
  if (isNew) {
    activateSubscription(userId, tier.days, chargeId);
  } else {
    // Telegram redelivered successful_payment — already activated, stay idempotent.
    console.warn(`duplicate successful_payment ${chargeId} for user ${userId} — skipped`);
  }
  // upgrade UX: switch to instant delivery by default
  savePrefs(userId, { delivery_mode: "instant" });

  const locale = getUser(userId)?.locale ?? "en";
  const until = new Date(Date.now() + tier.days * 86_400_000).toISOString().slice(0, 10);
  await ctx.reply(t(locale, "bot.plan_thanks", { until }));
}

/** Callback `refund:req:<rowid>` — confirm screen (charge_id is too long for callback_data). */
export async function onRefundRequest(ctx: Context, rowidStr: string): Promise<void> {
  const loc = locale(ctx);
  const userId = ctx.from!.id;
  const pay = getPaymentByRowid(Number(rowidStr));

  if (!pay || pay.user_id !== userId || pay.refund_at !== null) {
    await ctx.answerCallbackQuery({ text: t(loc, "bot.refund_unavailable"), show_alert: true });
    return;
  }
  const kb = new InlineKeyboard()
    .text(t(loc, "bot.refund_yes", { stars: pay.stars_amount }), `refund:yes:${pay.rowid}`)
    .row()
    .text(t(loc, "bot.refund_no"), "refund:no");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    t(loc, "bot.refund_confirm", {
      stars: pay.stars_amount,
      date: pay.paid_at.slice(0, 10),
      days: pay.period_days,
    }),
    { reply_markup: kb },
  );
}

/** Callback `refund:yes:<rowid>` — executes the Stars refund. */
export async function onRefundConfirm(ctx: Context, rowidStr: string): Promise<void> {
  const loc = locale(ctx);
  const userId = ctx.from!.id;
  const windowDays = getConfig().model.subscription.refund_window_days;
  const refundable = listRefundablePayments(userId, windowDays);
  const pay = refundable.find((p) => p.rowid === Number(rowidStr));

  if (!pay) {
    await ctx.answerCallbackQuery({ text: t(loc, "bot.refund_unavailable"), show_alert: true });
    return;
  }

  try {
    await ctx.api.refundStarPayment(userId, pay.charge_id);
  } catch (err) {
    console.error("refundStarPayment failed:", err);
    await ctx.answerCallbackQuery({ text: t(loc, "bot.refund_failed"), show_alert: true });
    return;
  }

  // Telegram already returned the Stars — bookkeeping must not fail silently.
  let res: ReturnType<typeof applyRefund>;
  try {
    res = applyRefund(pay.charge_id);
  } catch (err) {
    console.error(`refund bookkeeping failed for ${pay.charge_id} (Stars already refunded):`, err);
    res = "unknown";
  }
  const expiresAt = res === "already_refunded" || res === "unknown" ? null : res.expiresAt;
  if (expiresAt === null) {
    savePrefs(userId, { delivery_mode: "digest" });
    await ctx.editMessageText(t(loc, "bot.refund_done_canceled", { stars: pay.stars_amount }));
  } else {
    await ctx.editMessageText(
      t(loc, "bot.refund_done", { stars: pay.stars_amount, until: expiresAt.slice(0, 10) }),
    );
  }
}
