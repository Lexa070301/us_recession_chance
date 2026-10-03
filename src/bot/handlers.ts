import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getConfig } from "../config/load.js";
import {
  getAllSignalStates,
  getLatestComposite,
} from "../data/repositories/signalState.js";
import { SEVERITY_ORDER, type SignalState } from "../data/repositories/signalState.js";
import { getPrefs, getUser, savePrefs, setUserLocale } from "../data/repositories/users.js";
import {
  getSubscription,
  isSubscriptionActive,
  listRefundablePayments,
} from "../data/repositories/subscriptions.js";
import { computeComposite } from "../signals/score.js";
import { t } from "../publish/render/i18n.js";
import { renderAnalytics, renderStatus } from "../publish/render/templates.js";
import { digestTimeMinutes } from "../jobs/digest.js";

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

export async function cmdAnalytics(ctx: Context): Promise<void> {
  const user = getUser(ctx.from!.id);
  if (user?.plan !== "plus") {
    await ctx.reply(t(locale(ctx), "bot.settings_plus_only"));
    return;
  }
  await ctx.reply(renderAnalytics(getAllSignalStates(), locale(ctx)));
}

/** /digest HH:MM — custom daily digest time (UTC), /digest off resets. */
export async function cmdDigest(ctx: Context): Promise<void> {
  const loc = locale(ctx);
  const user = getUser(ctx.from!.id);
  if (user?.plan !== "plus") {
    await ctx.reply(t(loc, "bot.settings_plus_only"));
    return;
  }
  const arg = String(ctx.match ?? "").trim().toLowerCase();
  const def = getConfig().channels.defaults.digest_time_utc;
  if (arg === "off") {
    savePrefs(ctx.from!.id, { digest_time: null });
    await ctx.reply(t(loc, "bot.digest_time_reset", { default: def }));
    return;
  }
  const norm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(arg);
  if (!norm || digestTimeMinutes(arg) === null) {
    await ctx.reply(t(loc, "bot.digest_invalid"));
    return;
  }
  const hhmm = `${norm[1].padStart(2, "0")}:${norm[2]}`;
  savePrefs(ctx.from!.id, { digest_time: hhmm });
  await ctx.reply(t(loc, "bot.digest_time_set", { time: hhmm }));
}

// ------------------------------------------------------------------
// Keyboards
// ------------------------------------------------------------------

function settingsKeyboard(ctx: Context): InlineKeyboard {
  const userId = ctx.from!.id;
  const prefs = getPrefs(userId);
  const isPlus = getUser(userId)?.plan === "plus";
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

  if (isPlus) {
    kb.text(`${prefs.daily_digest ? "✅" : "⬜"} ${t(loc, "bot.settings_daily_digest")}`, "set:digest_daily").row();
    kb.text(`${prefs.weekly_digest ? "✅" : "⬜"} ${t(loc, "bot.settings_weekly_digest")}`, "set:digest_weekly").row();
    kb.text(`${prefs.nowcast_alerts ? "✅" : "⬜"} ${t(loc, "bot.settings_nowcast")}`, "set:nowcast").row();
    kb.text(
      `${t(loc, "bot.settings_score_alert")}: ${prefs.score_threshold ?? t(loc, "bot.settings_score_off")}`,
      "set:score",
    ).row();
    kb.text(
      `${t(loc, "bot.settings_digest_time")}: ${prefs.digest_time ?? getConfig().channels.defaults.digest_time_utc}`,
      "set:digest_time",
    ).row();
  } else {
    kb.text(t(loc, "bot.upgrade_hint"), "set:upgrade").row();
  }

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

  if (data === "set:digest_daily" || data === "set:digest_weekly" || data === "set:nowcast") {
    if (getUser(userId)?.plan !== "plus") {
      await ctx.answerCallbackQuery({ text: t(loc, "bot.settings_plus_only"), show_alert: true });
      return;
    }
    const prefs = getPrefs(userId);
    const field =
      data === "set:digest_daily"
        ? "daily_digest"
        : data === "set:digest_weekly"
          ? "weekly_digest"
          : "nowcast_alerts";
    savePrefs(userId, { [field]: !prefs[field] });
    await ctx.answerCallbackQuery({ text: t(loc, "bot.settings_updated") });
    await ctx.editMessageReplyMarkup({ reply_markup: settingsKeyboard(ctx) });
    return;
  }

  if (data === "set:score") {
    if (getUser(userId)?.plan !== "plus") {
      await ctx.answerCallbackQuery({ text: t(loc, "bot.settings_plus_only"), show_alert: true });
      return;
    }
    const prefs = getPrefs(userId);
    const cycle: (number | null)[] = [null, 3, 5, 7, 9, 13];
    const idx = cycle.indexOf(prefs.score_threshold);
    savePrefs(userId, { score_threshold: cycle[(idx + 1) % cycle.length] });
    await ctx.answerCallbackQuery({ text: t(loc, "bot.settings_updated") });
    await ctx.editMessageReplyMarkup({ reply_markup: settingsKeyboard(ctx) });
    return;
  }

  if (data === "set:digest_time") {
    if (getUser(userId)?.plan !== "plus") {
      await ctx.answerCallbackQuery({ text: t(loc, "bot.settings_plus_only"), show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      t(loc, "bot.digest_time_hint", { default: getConfig().channels.defaults.digest_time_utc }),
    );
    return;
  }

  if (data === "set:upgrade") {
    await ctx.answerCallbackQuery();
    await cmdPlan(ctx);
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

// ------------------------------------------------------------------
// Terms / payment support (required by Telegram bot-payments rules)
// ------------------------------------------------------------------

export async function cmdTerms(ctx: Context): Promise<void> {
  const loc = locale(ctx);
  const cfg = getConfig().model.subscription;
  await ctx.reply(
    t(loc, "bot.terms", {
      stars: cfg.stars_per_30d,
      days: cfg.period_days,
      refund_days: cfg.refund_window_days,
    }),
  );
}

export async function cmdPaySupport(ctx: Context): Promise<void> {
  const loc = locale(ctx);
  const cfg = getConfig().model.subscription;
  const payments = listRefundablePayments(ctx.from!.id, cfg.refund_window_days);

  const kb = new InlineKeyboard();
  for (const p of payments) {
    kb.text(
      t(loc, "bot.refund_item", { stars: p.stars_amount, date: p.paid_at.slice(0, 10) }),
      `refund:req:${p.charge_id}`,
    ).row();
  }
  const text =
    t(loc, "bot.paysupport", { refund_days: cfg.refund_window_days, days: cfg.period_days }) +
    (payments.length ? "" : `\n\n${t(loc, "bot.refund_none")}`);
  await ctx.reply(text, { reply_markup: kb });
}

// ------------------------------------------------------------------
// Buy flow: Telegram requires explicit ToS consent before the invoice
// ------------------------------------------------------------------

export async function onBuyPlus(ctx: Context): Promise<void> {
  const loc = locale(ctx);
  const cfg = getConfig().model.subscription;
  await ctx.answerCallbackQuery();
  await ctx.reply(t(loc, "bot.terms_consent"), {
    reply_markup: new InlineKeyboard().text(
      t(loc, "bot.pay_agree", { stars: cfg.stars_per_30d }),
      "buy:plus:pay",
    ),
  });
}

export async function onPayInvoice(ctx: Context): Promise<void> {
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
