/**
 * Public command menu — the single source for what shows up in Telegram's
 * "/" autocomplete. Synced via `npm run commands` (src/cli/setCommands.ts),
 * which calls setMyCommands per supported locale using `bot.cmd.<name>`
 * descriptions from the locale files.
 *
 * Keep this list in sync with the bot.command() registrations in index.ts:
 * internal triggers (digest), aliases (lang — lives in settings) and the
 * implicit /start stay out of the user-facing menu.
 */
export const MENU_COMMANDS: string[] = [
  "status",
  "guide",
  "signals",
  "analytics",
  "now",
  "episodes",
  "dashboard",
  "settings",
  "plan",
  "terms",
  "paysupport",
];
