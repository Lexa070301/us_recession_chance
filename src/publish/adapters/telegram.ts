import { Api, InputFile } from "grammy";
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
 *
 * `previewUrl` — when set, Telegram renders that link's og:image as a large
 * preview above the text (weekly digest → site page backed by card.png).
 * Must match a URL present in the message text. All other deliveries keep
 * previews disabled (same as before — avoids random thumbnails).
 */
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  previewUrl?: string,
): Promise<void> {
  const tg = getTelegramApi();
  const preview = previewUrl
    ? ({
        link_preview_options: {
          url: previewUrl,
          prefer_large_media: true,
          show_above_text: true,
        },
      } as const)
    : ({ link_preview_options: { is_disabled: true } } as const);
  try {
    await tg.sendMessage(chatId, text, { parse_mode: "Markdown", ...preview });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("can't parse entities") || msg.includes("Bad Request: can't parse")) {
      await tg.sendMessage(chatId, text, preview);
      return;
    }
    throw err;
  }
}

/**
 * Send a photo (digest card). Photos bypass the text-only outbox — callers
 * dedup via card_sent_keys and isolate failures from text delivery.
 * Caption <= 1024 chars (Telegram limit).
 */
export async function sendTelegramPhoto(
  chatId: string | number,
  png: Buffer,
  caption?: string,
): Promise<void> {
  const tg = getTelegramApi();
  await tg.sendPhoto(chatId, new InputFile(png, "card.png"), caption ? { caption } : {});
}
