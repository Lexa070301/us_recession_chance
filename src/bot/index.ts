import { Bot } from "grammy";
import { getConfig } from "../config/load.js";
import { upsertUser } from "../data/repositories/users.js";
import {
  cmdLang,
  cmdPlan,
  cmdSettings,
  cmdSignals,
  cmdStart,
  cmdStatus,
  onBuyPlus,
  onCallbackQuery,
} from "./handlers.js";
import { onPreCheckout, onSuccessfulPayment } from "./payments.js";

export function createBot(): Bot {
  const token = getConfig().env.telegramBotToken;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set (see .env.example)");

  const bot = new Bot(token);

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
  bot.command("plan", cmdPlan);

  bot.on("callback_query:data", async (ctx) => {
    if (ctx.callbackQuery.data === "buy:plus") {
      await onBuyPlus(ctx);
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
