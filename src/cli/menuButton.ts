import "dotenv/config";
import { Api } from "grammy";

// Usage: SITE_URL=https://… tsx src/cli/menuButton.ts
// One-off: installs the "web_app" menu button for all private chats,
// opening the Mini App (PLAN2 §14). Idempotent — safe to re-run.

const token = process.env.TELEGRAM_BOT_TOKEN;
const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}
if (!siteUrl) {
  console.error("SITE_URL is not set (e.g. https://<user>.github.io/<repo>)");
  process.exit(1);
}

const api = new Api(token);
await api.setChatMenuButton({
  menu_button: {
    type: "web_app",
    text: "Dashboard",
    web_app: { url: `${siteUrl}/app/` },
  },
});
console.log(`Menu button set → ${siteUrl}/app/`);
