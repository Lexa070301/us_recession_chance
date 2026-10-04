import type Database from "better-sqlite3";
import { getDb } from "../data/db.js";
import { t } from "../publish/render/i18n.js";
import { episodeWindow } from "../bot/episodes.js";
import { renderArticleBody } from "./articles.js";
import { esc, pageShell, type SitePageOpts } from "./html.js";

/**
 * Static episode pages (SEO long-tail): one page per NBER recession in our
 * data range plus the 2023–24 inversion scare — NBER record, which signals
 * fired, peak severity, and an editorial write-up of the episode.
 * Same replay data as /episodes, latest-revision mode, in indexable HTML.
 */

interface SiteEpisode {
  /** Locale key under site.episode_name.<key> / site.article.<key>. */
  key: string;
  from: number;
  to: number;
}

/** Every NBER recession covered by our series history (USREC since 1966)
 * + the 2023–24 false-positive scare — honesty pages rank and build trust. */
export const SITE_EPISODES: SiteEpisode[] = [
  { key: "r1969", from: 1969, to: 1970 },
  { key: "r1973", from: 1973, to: 1975 },
  { key: "r1980", from: 1980, to: 1980 },
  { key: "r1981", from: 1981, to: 1982 },
  { key: "r1990", from: 1990, to: 1991 },
  { key: "r2001", from: 2001, to: 2001 },
  { key: "gfc", from: 2007, to: 2009 },
  { key: "covid", from: 2020, to: 2020 },
  { key: "scare2324", from: 2023, to: 2024 },
];

/** Slugs that shipped in the first episodes deploy — keep them alive with
 * a meta-refresh stub pointing at the new canonical page. */
const LEGACY_REDIRECTS: Record<string, string> = {
  "1980-1982": "1981-1982/",
  "2008-2009": "2007-2009/",
};

const rangeLabel = (from: number, to: number) => (from === to ? `${from}` : `${from}–${to}`);
const slug = (from: number, to: number) => (from === to ? `${from}` : `${from}-${to}`);

const SEV_COLOR: Record<string, string> = {
  ok: "#4ade80",
  watch: "#f59e0b",
  warning: "#f97316",
  critical: "#ef4444",
  none: "#475569",
};

function hitsTable(hits: ReturnType<typeof episodeWindow>["hits"], locale: string): string {
  const rows = hits
    .flatMap((h) =>
      h.episodes.map(
        (ep) =>
          `<tr><td><span class="dot" style="background:${SEV_COLOR[ep.peak] ?? SEV_COLOR.none}"></span>${esc(t(locale, `signal.${h.key}.name`))}</td>` +
          `<td class="val">${ep.start.slice(0, 7)} → ${ep.end ? ep.end.slice(0, 7) : "…"}</td>` +
          `<td class="st">${esc(t(locale, `severity.${ep.peak}`))}</td></tr>`,
      ),
    )
    .join("");
  return `<table class="sig-table">${rows}</table>`;
}

export function episodesIndexHtml(locale: string, opts: SitePageOpts): string {
  const list = SITE_EPISODES.map(
    (e) => `<li>
      <a href="${slug(e.from, e.to)}/">${esc(rangeLabel(e.from, e.to))}</a>
      — ${esc(t(locale, `site.episode_name.${e.key}`))}
    </li>`,
  ).join("\n");

  const body = `<div class="prose">
  <h1>${esc(t(locale, "site.episodes_title"))}</h1>
  <p>${esc(t(locale, "site.episodes_intro"))}</p>
  <ul class="audit-list">${list}</ul>
  <p><a href="../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, t(locale, "site.episodes_title"), body, {
    ...opts,
    description: t(locale, "site.episodes_intro"),
    pagePath: "/episodes/",
  });
}

function episodePageHtml(
  locale: string,
  ep: SiteEpisode,
  opts: SitePageOpts,
  conn?: Database.Database,
): string {
  const db = conn ?? getDb();
  const win = episodeWindow({ from: ep.from, to: ep.to, asof: false }, db);
  const range = rangeLabel(ep.from, ep.to);
  const name = t(locale, `site.episode_name.${ep.key}`);
  const title = t(locale, `site.article.${ep.key}.title`);

  const nber = win.recessions.length
    ? win.recessions
        .map(
          (r) =>
            `<li>${esc(t(locale, "episodes.nber", { period: `${r.start}–${r.end}`, caught: r.caught, total: win.forecastCount }))}</li>`,
        )
        .join("")
    : `<li>${esc(t(locale, "episodes.nber_none"))}</li>`;

  const article = renderArticleBody(t(locale, `site.article.${ep.key}.body`));

  const body = `<div class="prose">
  <h1>${esc(title)}</h1>
  <p>${esc(name)} · ${esc(range)} · ${esc(t(locale, "episodes.mode_latest"))}</p>
  <ul class="audit-list">${nber}</ul>
  ${
    win.hits.length
      ? `<p>${esc(t(locale, "episodes.signal_header"))}</p>${hitsTable(win.hits, locale)}`
      : `<p>${esc(t(locale, "episodes.quiet"))}</p>`
  }
  <div class="disclaimer">${esc(t(locale, "episodes.note", { mode: t(locale, "episodes.mode_latest") }))}</div>
  <article class="episode-article">
    ${article}
  </article>
  <p><a href="../">${esc(t(locale, "site.episodes_title"))}</a> · <a href="../../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, `${title} — ${range}`, body, {
    ...opts,
    description: t(locale, "site.episode_desc", { range }),
    pagePath: `/episodes/${slug(ep.from, ep.to)}/`,
  });
}

/** Legacy slug → tiny redirect page (Pages has no server redirects). */
function redirectHtml(target: string, locale: string, opts: SitePageOpts): string {
  const siteUrl = (opts.siteUrl ?? "").replace(/\/$/, "");
  const base = opts.fallback === locale ? "" : `${locale}/`;
  const to = `${siteUrl}/${base}episodes/${target}`;
  return `<!doctype html><html lang="${esc(locale)}"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${esc(to)}">
<link rel="canonical" href="${esc(to)}">
<meta name="robots" content="noindex,follow">
<title>Redirect</title></head><body><a href="${esc(to)}">Moved → ${esc(to)}</a></body></html>`;
}

/** Index + one page per episode + legacy-slug stubs. [relpath, html][]. */
export function episodePages(
  locale: string,
  base: string,
  opts: SitePageOpts,
  conn?: Database.Database,
): [string, string][] {
  const db = conn ?? getDb();
  const pages: [string, string][] = [[`${base}/index.html`, episodesIndexHtml(locale, opts)]];
  for (const e of SITE_EPISODES) {
    pages.push([
      `${base}/${slug(e.from, e.to)}/index.html`,
      episodePageHtml(locale, e, opts, db),
    ]);
  }
  if (opts.fallback === locale) {
    for (const [old, target] of Object.entries(LEGACY_REDIRECTS)) {
      pages.push([`${base}/${old}/index.html`, redirectHtml(target, locale, opts)]);
    }
  }
  return pages;
}
