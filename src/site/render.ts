import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { getConfig } from "../config/load.js";
import { getDb } from "../data/db.js";
import { buildDashboardData } from "./dataJson.js";
import { indexHtml, type SitePageOpts } from "./html.js";
import { atomFeed } from "./feed.js";
import { methodHtml } from "./method.js";
import { auditPages, auditWeekLocales } from "./audit.js";
import { episodePages } from "./episodes.js";
import { signalPages } from "./signals.js";
import { glossaryPages } from "./glossary.js";
import { faqHtml } from "./faq.js";
import { historyHtml } from "./history.js";
import { aboutHtml } from "./about.js";

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

  // Search-console verification — only needs the homepage meta tag.
  const gsc = process.env.GOOGLE_SITE_VERIFICATION
    ? `<meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION}">`
    : "";
  const yandex = process.env.YANDEX_VERIFICATION
    ? `<meta name="yandex-verification" content="${process.env.YANDEX_VERIFICATION}">`
    : "";
  // Week pages may exist in one locale only — hreflang must not point at 404s.
  const weekLocales = auditWeekLocales(locales, db);

  for (const loc of locales) {
    const data = buildDashboardData(loc, db);
    // Feed link must resolve from BOTH root pages (feed-*.xml next to
    // index.html) and locale subpages (/ru/index.html → ../feed-ru.xml).
    const feedName = `feed-${loc}.xml`;
    const feedHref = loc === fallback ? feedName : `../${feedName}`;
    const indexOpts: SitePageOpts = {
      bot, feedHref, siteUrl, locales, fallback, extraHead: `${gsc}${yandex}`,
    };
    const html = indexHtml(data, loc, indexOpts);
    write(`data.${loc}.json`, JSON.stringify(data, null, 2));
    write(feedName, atomFeed(loc, siteUrl, db));
    const pageOpts: SitePageOpts = { bot, siteUrl, locales, fallback };
    const base = loc === fallback ? "" : `${loc}/`;
    write(`${base}index.html`, html);
    write(`${base}method/index.html`, methodHtml(loc, pageOpts));
    write(`${base}faq/index.html`, faqHtml(loc, pageOpts));
    write(`${base}history/index.html`, historyHtml(loc, pageOpts, db));
    write(`${base}about/index.html`, aboutHtml(loc, pageOpts));
    for (const [rel, page] of auditPages(loc, `${base}audit`, pageOpts, db, weekLocales)) {
      write(rel, page);
    }
    for (const [rel, page] of episodePages(loc, `${base}episodes`, pageOpts, db)) {
      write(rel, page);
    }
    for (const [rel, page] of signalPages(loc, `${base}signals`, pageOpts, db)) {
      write(rel, page);
    }
    for (const [rel, page] of glossaryPages(loc, `${base}glossary`, pageOpts)) {
      write(rel, page);
    }
    if (loc === fallback) {
      write("data.json", JSON.stringify(data, null, 2));
      write("feed.xml", atomFeed(loc, siteUrl, db));
    }
  }
  // artifact-deploy skips Jekyll anyway; .nojekyll keeps branch-deploys safe.
  write(".nojekyll", "");

  // robots.txt — honored only at host root (i.e. a custom domain or the
  // user-pages repo); still emitted so a future CNAME gets it for free.
  if (siteUrl) {
    write(
      "robots.txt",
      `User-agent: *\nAllow: /\nDisallow: /app/\n\nSitemap: ${siteUrl}/sitemap.xml\n`,
    );
    // Sitemap: every rendered HTML page, minus the trailing index.html.
    const today = new Date().toISOString().slice(0, 10);
    const urls = written
      .filter((rel) => rel.endsWith("index.html"))
      .map((rel) => `${siteUrl}/${rel.replace(/index\.html$/, "")}`)
      .map((loc) => `  <url><loc>${loc}</loc><lastmod>${today}</lastmod></url>`)
      .join("\n");
    write(
      "sitemap.xml",
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    );
  }

  // Mini App (PLAN2 §14): versioned sources in web/app/ → site/app/.
  const appSrc = join(dirname(fileURLToPath(import.meta.url)), "../../web/app");
  const appDest = join(outDir, "app");
  if (existsSync(appSrc)) {
    cpSync(appSrc, appDest, { recursive: true });
    written.push("app/index.html", "app/app.js", "app/styles.css");
  }
  const faviconSrc = join(dirname(fileURLToPath(import.meta.url)), "../../web/favicon.svg");
  if (existsSync(faviconSrc)) {
    cpSync(faviconSrc, join(outDir, "favicon.svg"));
    written.push("favicon.svg");
  }
  return written;
}
