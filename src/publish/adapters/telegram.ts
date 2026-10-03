import { Api } from "grammy";
import { getConfig } from "../../config/load.js";

let api: Api | undefined;

export function getTelegramApi(): Api {
  if (api) return api;
  const token = getConfig().env.telegramBotToken;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set (see .env.example)");
  api = new Api(token);
  return api;
}

/**
 * Send a message via Bot API. Tries legacy Markdown first (templates use
 * `_italic_`), falls back to plain text on formatting errors.
 * Throws on transport/API errors so the caller can record failure.
 */
export async function sendTelegramMessage(chatId: string | number, text: string): Promise<void> {
  const tg = getTelegramApi();
  const noPreview = { link_preview_options: { is_disabled: true } } as const;
  try {
    await tg.sendMessage(chatId, text, { parse_mode: "Markdown", ...noPreview });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("can't parse entities") || msg.includes("Bad Request: can't parse")) {
      await tg.sendMessage(chatId, text, noPreview);
      return;
    }
    throw err;
  }
}
