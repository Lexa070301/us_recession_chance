import "dotenv/config";
import { Api } from "grammy";
import type { LanguageCode } from "grammy/types";
import { MENU_COMMANDS } from "../bot/commands.js";
import { getConfig } from "../config/load.js";
import { t } from "../publish/render/i18n.js";

// Usage: tsx src/cli/setCommands.ts
// One-off: syncs the "/" autocomplete menu with MENU_COMMANDS — a default
// list plus a per-locale list for every supported locale, so ru users see
// ru descriptions. Idempotent; re-run after adding commands or locales.

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const api = new Api(token);
const locales = getConfig().channels.defaults.supported_locales;
const fallback = getConfig().channels.defaults.fallback_locale;

// language_code unset = the default list shown to everyone whose Telegram
// UI language has no explicit list.
for (const loc of [undefined, ...locales]) {
  const effective = loc ?? fallback;
  const commands = MENU_COMMANDS.map((c) => ({
    command: c,
    description: t(effective, `bot.cmd.${c}`).slice(0, 256),
  }));
  await api.setMyCommands(commands, loc ? { language_code: loc as LanguageCode } : undefined);
  console.log(`[commands] ${loc ?? "default"}: ${commands.map((c) => `/${c.command}`).join(" ")}`);
}
