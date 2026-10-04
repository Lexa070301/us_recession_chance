import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getConfig } from "../config/load.js";
import {
  getAllSignalStates,
  getLatestComposite,
  getRecentEvents,
} from "../data/repositories/signalState.js";
import { SEVERITY_ORDER, type SignalState } from "../data/repositories/signalState.js";
import { getPrefs, getUser, savePrefs, setUserLocale } from "../data/repositories/users.js";
import {
  getSubscription,
  isSubscriptionActive,
  listRefundablePayments,
} from "../data/repositories/subscriptions.js";
import { findTier } from "./payments.js";
import { bucketForScore, computeComposite } from "../signals/score.js";
import { computePooledProb } from "../signals/pooledProb.js";
import { parseEpisodesArgs, renderEpisodes } from "./episodes.js";
import { t } from "../publish/render/i18n.js";
import {
  renderAnalytics,
  renderNow,
  renderStatus,
} from "../publish/render/templates.js";
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

export async function cmdGuide(ctx: Context): Promise<void> {
  await ctx.reply(t(locale(ctx), "bot.guide"));
}

/** /dashboard — open the Telegram Mini App hosted on GitHub Pages (§14). */
export async function cmdDashboard(ctx: Context): Promise<void> {
  const loc = locale(ctx);
  const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");
  if (!siteUrl) {
    await ctx.reply(t(loc, "bot.dashboard_unavailable"));
    return;
  }
  const kb = new InlineKeyboard().webApp(t(loc, "bot.dashboard_button"), `${siteUrl}/app/`);
  await ctx.reply(t(loc, "bot.dashboard_text"), { reply_markup: kb });
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

/** /now (PLAN2 §11): paid instant snapshot — status + last-24h transitions. */
export async function cmdNow(ctx: Context): Promise<void> {
  const user = getUser(ctx.from!.id);
  if (user?.plan !== "plus") {
    await ctx.reply(t(locale(ctx), "bot.settings_plus_only"));
    return;
  }
  const states = getAllSignalStates();
  const composite = computeComposite(
    new Map(states.map((s) => [s.signal_key, s])),
    getConfig().signals,
  );
  composite.modelProb = computePooledProb();
  await ctx.reply(renderNow(states, composite, getRecentEvents(24), locale(ctx)));
}

/** /episodes 2008 [–2009] [asof] — paid historical episode search (§10). */
export async function cmdEpisodes(ctx: Context): Promise<void> {
  const loc = locale(ctx);
  const user = getUser(ctx.from!.id);
  if (user?.plan !== "plus") {
    await ctx.reply(t(loc, "bot.settings_plus_only"));
    return;
  }
  const args = parseEpisodesArgs(String(ctx.match ?? ""));
  if (!args) {
    await ctx.reply(t(loc, "episodes.usage"));
    return;
  }
  await ctx.reply(renderEpisodes(args, loc));
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
    const th = prefs.score_threshold;
    const thLabel =
      th === null
        ? t(loc, "bot.settings_score_off")
        : `${th}+ · ${t(loc, `bucket.${bucketForScore(th)}`)}`;
    kb.text(`${t(loc, "bot.settings_score_alert")}: ${thLabel}`, "set:score").row();
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
    // Cycle through bucket boundaries (PLAN2 §9): thresholds that mean
    // something — off, then each band's min above zero.
    const cycle: (number | null)[] = [
      null,
      ...getConfig().model.composite.bands.map((b) => b.min).filter((m) => m > 0),
    ];
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
  const tiers = getConfig().model.subscription.tiers;

  if (isSubscriptionActive(userId)) {
    const until = getSubscription(userId)?.expires_at?.slice(0, 10) ?? "";
    await ctx.reply(t(loc, "bot.plan_active", { until }));
    return;
  }

  const base = tiers.find((tier) => tier.days === 30) ?? tiers[0];
  const baseRate = base.stars / base.days;
  const kb = new InlineKeyboard();
  for (const tier of tiers) {
    const pct = Math.round((1 - tier.stars / tier.days / baseRate) * 100);
    const key = pct > 0 ? "bot.plan_tier_disc" : "bot.plan_tier";
    kb.text(t(loc, key, { days: tier.days, stars: tier.stars, pct }), `buy:plus:${tier.days}`).row();
  }

  await ctx.reply(t(loc, "bot.plan_desc"), { reply_markup: kb });
}

// ------------------------------------------------------------------
// Terms / payment support (required by Telegram bot-payments rules)
// ------------------------------------------------------------------

export async function cmdTerms(ctx: Context): Promise<void> {
  const loc = locale(ctx);
  const cfg = getConfig().model.subscription;
  await ctx.reply(t(loc, "bot.terms", { refund_days: cfg.refund_window_days }));
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
    t(loc, "bot.paysupport", { refund_days: cfg.refund_window_days }) +
    (payments.length ? "" : `\n\n${t(loc, "bot.refund_none")}`);
  // No payments → empty keyboard serializes as inline_keyboard:[[]], which
  // Telegram rejects — the reply throws and the user sees silence (bug).
  await ctx.reply(text, payments.length ? { reply_markup: kb } : {});
}

// ------------------------------------------------------------------
// Buy flow: Telegram requires explicit ToS consent before the invoice
// ------------------------------------------------------------------

export async function onBuyPlus(ctx: Context, days: number): Promise<void> {
  const loc = locale(ctx);
  const tier = findTier(days);
  if (!tier) {
    await ctx.answerCallbackQuery({ text: t(loc, "bot.error_generic"), show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.reply(t(loc, "bot.terms_consent"), {
    reply_markup: new InlineKeyboard().text(
      t(loc, "bot.pay_agree", { stars: tier.stars }),
      `buy:plus:pay:${tier.days}`,
    ),
  });
}

export async function onPayInvoice(ctx: Context, days: number): Promise<void> {
  const loc = locale(ctx);
  const tier = findTier(days);
  if (!tier) {
    await ctx.answerCallbackQuery({ text: t(loc, "bot.error_generic"), show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.replyWithInvoice(
    t(loc, "bot.plan_title"),
    t(loc, "bot.plan_invoice", { days: tier.days }),
    `plus:${tier.days}:${ctx.from!.id}:${Date.now()}`,
    "XTR",
    [{ label: t(loc, "bot.plan_title"), amount: tier.stars }],
    { provider_token: "" },
  );
}

export { SEVERITY_ORDER };
