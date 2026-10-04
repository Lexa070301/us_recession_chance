import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { getConfig } from "../config/load.js";
import { getDb } from "../data/db.js";
import { buildDashboardData } from "./dataJson.js";
import { indexHtml } from "./html.js";
import { atomFeed } from "./feed.js";

/**
 * GitHub Pages site (PLAN2 §2): static dashboard + Atom feeds + data.json
 * consumed by the Mini App. Deployed by the `pages` job in monitor.yml.
 *
 * Layout:
 *   index.html        — default-locale dashboard
 *   ru/index.html     — per-locale dashboards
 *   data.json         — default-locale payload (Mini App fallback)
 *   data.<loc>.json   — per-locale payloads
 *   feed.<loc>.xml    — Atom feeds (root feed.xml = default locale)
 *   app/index.html    — Mini App shell (generated separately)
 */

export function renderSite(outDir: string, conn?: Database.Database): string[] {
  const db = conn ?? getDb();
  const cfg = getConfig();
  const locales = cfg.channels.defaults.supported_locales;
  const fallback = cfg.channels.defaults.fallback_locale;
  const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");
  const bot = cfg.env.botUsername;

  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const write = (rel: string, content: string) => {
    const p = join(outDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
    written.push(rel);
  };

  for (const loc of locales) {
    const data = buildDashboardData(loc, db);
    // Feed link must resolve from BOTH root pages (feed-*.xml next to
    // index.html) and locale subpages (/ru/index.html → ../feed-ru.xml).
    const feedName = `feed-${loc}.xml`;
    const feedHref = loc === fallback ? feedName : `../${feedName}`;
    const html = indexHtml(data, loc, { bot, feedHref });
    write(`data.${loc}.json`, JSON.stringify(data, null, 2));
    write(feedName, atomFeed(loc, siteUrl, db));
    if (loc === fallback) {
      write("index.html", html);
      write("data.json", JSON.stringify(data, null, 2));
      write("feed.xml", atomFeed(loc, siteUrl, db));
    } else {
      write(`${loc}/index.html`, html);
    }
  }
  // artifact-deploy skips Jekyll anyway; .nojekyll keeps branch-deploys safe.
  write(".nojekyll", "");

  // Mini App (PLAN2 §14): versioned sources in web/app/ → site/app/.
  const appSrc = join(dirname(fileURLToPath(import.meta.url)), "../../web/app");
  const appDest = join(outDir, "app");
  if (existsSync(appSrc)) {
    cpSync(appSrc, appDest, { recursive: true });
    written.push("app/index.html", "app/app.js", "app/styles.css");
  }
  return written;
}
