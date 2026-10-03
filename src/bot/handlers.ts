import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getConfig } from "../config/load.js";
import {
  getAllSignalStates,
  getLatestComposite,
} from "../data/repositories/signalState.js";
import { SEVERITY_ORDER, type SignalState } from "../data/repositories/signalState.js";
import { getPrefs, getUser, savePrefs, setUserLocale } from "../data/repositories/users.js";
import { getSubscription, isSubscriptionActive } from "../data/repositories/subscriptions.js";
import { computeComposite } from "../signals/score.js";
import { t } from "../publish/render/i18n.js";
import { renderStatus } from "../publish/render/templates.js";

function locale(ctx: Context): string {
  const id = ctx.from?.id;
  if (!id) return getConfig().channels.defaults.fallback_locale;
  return getUser(id)?.locale ?? getConfig().channels.defaults.fallback_locale;
}

const SEVERITIES: Exclude<SignalState, "ok">[] = ["watch", "warning", "critical"];

// ------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------

export async function cmdStart(ctx: Context): Promise<void> {
  await ctx.reply(t(locale(ctx), "bot.start"));
}

export async function cmdStatus(ctx: Context): Promise<void> {
  const states = getAllSignalStates();
  const composite = computeComposite(
    new Map(states.map((s) => [s.signal_key, s])),
    getConfig().signals,
  );
  await ctx.reply(renderStatus(states, composite, locale(ctx)));
}

export async function cmdSettings(ctx: Context): Promise<void> {
  await ctx.reply(t(locale(ctx), "bot.settings_title"), {
    reply_markup: settingsKeyboard(ctx),
  });
}

export async function cmdLang(ctx: Context): Promise<void> {
  const kb = new InlineKeyboard()
    .text("English", "set:lang:en")
    .text("Русский", "set:lang:ru");
  await ctx.reply(t(locale(ctx), "bot.settings_lang"), { reply_markup: kb });
}

export async function cmdSignals(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const user = getUser(userId);
  if (user?.plan !== "plus") {
    await ctx.reply(t(locale(ctx), "bot.settings_plus_only"));
    return;
  }
  await ctx.reply(t(locale(ctx), "bot.signals_title"), {
    reply_markup: signalsKeyboard(ctx),
  });
}

// ------------------------------------------------------------------
// Keyboards
// ------------------------------------------------------------------

function settingsKeyboard(ctx: Context): InlineKeyboard {
  const userId = ctx.from!.id;
  const prefs = getPrefs(userId);
  const loc = locale(ctx);
  const kb = new InlineKeyboard();

  const deliveryLabel =
    prefs.delivery_mode === "instant"
      ? t(loc, "bot.delivery_instant")
      : t(loc, "bot.delivery_digest");
  kb.text(`${t(loc, "bot.settings_delivery")}: ${deliveryLabel}`, "set:delivery").row();

  const nextSev =
    SEVERITIES[(SEVERITIES.indexOf(prefs.min_severity) + 1) % SEVERITIES.length];
  kb.text(
    `${t(loc, "bot.settings_min_severity")}: ${t(loc, `severity.${prefs.min_severity}`)} → ${t(loc, `severity.${nextSev}`)}`,
    "set:severity",
  ).row();

  kb.text(t(loc, "bot.settings_lang"), "set:lang_menu").row();
  return kb;
}

function signalsKeyboard(ctx: Context): InlineKeyboard {
  const userId = ctx.from!.id;
  const prefs = getPrefs(userId);
  const enabled = prefs.enabled_signals;
  const kb = new InlineKeyboard();

  for (const sig of getConfig().signals.filter((s) => s.block !== "nowcast")) {
    const on = enabled === null || enabled.includes(sig.key);
    kb.text(`${on ? "✅" : "⬜"} ${t(locale(ctx), `signal.${sig.key}.name`)}`, `sig:${sig.key}`).row();
  }
  return kb;
}

// ------------------------------------------------------------------
// Callback queries
// ------------------------------------------------------------------

export async function onCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const userId = ctx.from!.id;
  const loc = locale(ctx);

  if (data.startsWith("sig:")) {
    const user = getUser(userId);
    if (user?.plan !== "plus") {
      await ctx.answerCallbackQuery({ text: t(loc, "bot.settings_plus_only"), show_alert: true });
      return;
    }
    const key = data.slice(4);
    const prefs = getPrefs(userId);
    const all = getConfig().signals.map((s) => s.key);
    const current = prefs.enabled_signals ?? [...all];
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    savePrefs(userId, { enabled_signals: next.length === all.length ? null : next });
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: signalsKeyboard(ctx) });
    return;
  }

  if (data === "set:delivery") {
    const user = getUser(userId);
    const prefs = getPrefs(userId);
    if (user?.plan !== "plus" && prefs.delivery_mode === "digest") {
      await ctx.answerCallbackQuery({ text: t(loc, "bot.settings_plus_only"), show_alert: true });
      return;
    }
    savePrefs(userId, { delivery_mode: prefs.delivery_mode === "instant" ? "digest" : "instant" });
    await ctx.answerCallbackQuery({ text: t(loc, "bot.settings_updated") });
    await ctx.editMessageReplyMarkup({ reply_markup: settingsKeyboard(ctx) });
    return;
  }

  if (data === "set:severity") {
    const prefs = getPrefs(userId);
    const next = SEVERITIES[(SEVERITIES.indexOf(prefs.min_severity) + 1) % SEVERITIES.length];
    savePrefs(userId, { min_severity: next });
    await ctx.answerCallbackQuery({ text: t(loc, "bot.settings_updated") });
    await ctx.editMessageReplyMarkup({ reply_markup: settingsKeyboard(ctx) });
    return;
  }

  if (data === "set:lang_menu") {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text("English", "set:lang:en").text("Русский", "set:lang:ru");
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    return;
  }

  if (data.startsWith("set:lang:")) {
    const lang = data.slice(9);
    setUserLocale(userId, lang);
    await ctx.answerCallbackQuery({ text: "OK" });
    await ctx.reply(t(lang, "bot.settings_updated"));
    return;
  }

  await ctx.answerCallbackQuery();
}

// ------------------------------------------------------------------
// Plan / payments command
// ------------------------------------------------------------------

export async function cmdPlan(ctx: Context): Promise<void> {
  const loc = locale(ctx);
  const userId = ctx.from!.id;
  const cfg = getConfig().model.subscription;

  if (isSubscriptionActive(userId)) {
    const until = getSubscription(userId)?.expires_at?.slice(0, 10) ?? "";
    await ctx.reply(t(loc, "bot.plan_active", { until }));
    return;
  }

  await ctx.reply(t(loc, "bot.plan_desc", { stars: cfg.stars_per_30d, days: cfg.period_days }), {
    reply_markup: new InlineKeyboard().text(`💎 ${cfg.stars_per_30d} ⭐`, "buy:plus"),
  });
}

export async function onBuyPlus(ctx: Context): Promise<void> {
  const loc = locale(ctx);
  const cfg = getConfig().model.subscription;
  await ctx.answerCallbackQuery();
  await ctx.replyWithInvoice(
    t(loc, "bot.plan_title"),
    t(loc, "bot.plan_invoice", { days: cfg.period_days }),
    `plus_${ctx.from!.id}_${Date.now()}`,
    "XTR",
    [{ label: t(loc, "bot.plan_title"), amount: cfg.stars_per_30d }],
    { provider_token: "" },
  );
}

export { SEVERITY_ORDER };
