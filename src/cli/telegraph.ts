import "dotenv/config";
import { getConfig } from "../config/load.js";
import { t } from "../publish/render/i18n.js";

// Usage: npm run telegraph-token -- [--loc en]
// One-off: creates a Telegraph account per supported locale and prints the
// TELEGRAPH_TOKEN_<LOC> value to paste into secrets. NOT idempotent — every
// run creates a new account; old tokens stay valid but become orphan pages.

const locIdx = process.argv.indexOf("--loc");
const locales = locIdx > -1
  ? [process.argv[locIdx + 1]]
  : getConfig().channels.defaults.supported_locales;
const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");

interface TelegraphAccount {
  ok: boolean;
  result?: { access_token: string; short_name: string };
  error?: string;
}

for (const loc of locales) {
  const res = (await fetch("https://api.telegra.ph/createAccount", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      short_name: `us-recession-chance-${loc}`,
      author_name: t(loc, "app.name"),
      author_url: siteUrl || undefined,
    }),
  }).then((r) => r.json())) as TelegraphAccount;
  if (!res.ok || !res.result) throw new Error(`telegraph ${loc}: ${res.error ?? "no result"}`);
  console.log(`TELEGRAPH_TOKEN_${loc.toUpperCase()}=${res.result.access_token}`);
}
