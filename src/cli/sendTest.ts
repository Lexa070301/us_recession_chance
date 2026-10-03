import "dotenv/config";
import { getChannelTargets } from "../config/load.js";
import { sendTelegramMessage } from "../publish/adapters/telegram.js";

// Usage: tsx src/cli/sendTest.ts [chatId]
// Without args: sends a test message to every configured channel.
const target = process.argv[2];

async function main() {
  const text = `✅ us-recession-chance test message — ${new Date().toISOString()}`;
  if (target) {
    await sendTelegramMessage(target, text);
    console.log(`Sent to ${target}`);
    return;
  }
  const channels = getChannelTargets();
  if (!channels.length) {
    console.error("No channels configured (set TG_CHANNEL_* env vars)");
    process.exitCode = 1;
    return;
  }
  for (const ch of channels) {
    await sendTelegramMessage(ch.chatId, `[${ch.locale}] ${text}`);
    console.log(`Sent to ${ch.id} (${ch.locale})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
