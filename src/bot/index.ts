import { Bot } from "grammy";
import { getConfig } from "../config/load.js";
import { upsertUser } from "../data/repositories/users.js";
import {
  cmdAnalytics,
  cmdDigest,
  cmdLang,
  cmdPaySupport,
  cmdPlan,
  cmdSettings,
  cmdSignals,
  cmdStart,
  cmdStatus,
  cmdTerms,
  onBuyPlus,
  onCallbackQuery,
  onPayInvoice,
} from "./handlers.js";
import {
  onPreCheckout,
  onRefundConfirm,
  onRefundRequest,
  onSuccessfulPayment,
} from "./payments.js";

export function createBot(): Bot {
  const env = getConfig().env;
  if (!env.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is not set (see .env.example)");

  // TG_ENV=test → Telegram test DC (free Stars; needs a test-env bot token)
  const bot = new Bot(env.telegramBotToken, { client: { environment: env.tgEnv } });

  // Track every interacting user (idempotent)
  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat?.type === "private") {
      const lang = ctx.from.language_code?.slice(0, 2) ?? "en";
      upsertUser(ctx.from.id, ctx.from.username ?? null, lang);
    }
    return next();
  });

  bot.command("start", cmdStart);
  bot.command("status", cmdStatus);
  bot.command("settings", cmdSettings);
  bot.command("lang", cmdLang);
  bot.command("signals", cmdSignals);
  bot.command("analytics", cmdAnalytics);
  bot.command("digest", cmdDigest);
  bot.command("plan", cmdPlan);
  bot.command("terms", cmdTerms);
  bot.command("paysupport", cmdPaySupport);

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("buy:plus:pay:")) {
      await onPayInvoice(ctx, Number(data.slice(13)));
      return;
    }
    if (data.startsWith("buy:plus:")) {
      await onBuyPlus(ctx, Number(data.slice(9)));
      return;
    }
    if (data === "buy:plus") {
      const base = getConfig().model.subscription.tiers.find((t) => t.days === 30);
      await onBuyPlus(ctx, base?.days ?? getConfig().model.subscription.tiers[0].days);
      return;
    }
    if (data.startsWith("refund:req:")) {
      await onRefundRequest(ctx, data.slice(11));
      return;
    }
    if (data.startsWith("refund:yes:")) {
      await onRefundConfirm(ctx, data.slice(11));
      return;
    }
    if (data === "refund:no") {
      await ctx.answerCallbackQuery();
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }
    await onCallbackQuery(ctx);
  });

  bot.on("pre_checkout_query", onPreCheckout);
  bot.on("message:successful_payment", onSuccessfulPayment);

  bot.catch((err) => {
    console.error("Bot error:", err.error ?? err);
  });

  return bot;
}
