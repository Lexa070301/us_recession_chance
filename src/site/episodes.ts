import type Database from "better-sqlite3";
import { getDb } from "../data/db.js";
import { t } from "../publish/render/i18n.js";
import { SEVERITY_ORDER } from "../data/repositories/signalState.js";
import { EPISODE_PRESETS, episodeWindow } from "../bot/episodes.js";
import { esc, pageShell, type SitePageOpts } from "./html.js";

/**
 * Static episode pages (SEO long-tail): one page per preset recession
 * window — NBER record, which signals fired and their peak severity.
 * Same replay data as /episodes, latest-revision mode, in indexable HTML.
 */

const rangeLabel = (from: number, to: number) => (from === to ? `${from}` : `${from}–${to}`);
export const episodeSlug = (from: number, to: number) =>
  from === to ? `${from}` : `${from}-${to}`;

const SEV_COLOR: Record<string, string> = {
  ok: "#4ade80",
  watch: "#f59e0b",
  warning: "#f97316",
  critical: "#ef4444",
  none: "#475569",
};

function hitsTable(
  hits: ReturnType<typeof episodeWindow>["hits"],
  locale: string,
): string {
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
  const list = EPISODE_PRESETS.map(
    (p) => `<li>
      <a href="${episodeSlug(p.from, p.to)}/">${esc(rangeLabel(p.from, p.to))}</a>
      — ${esc(t(locale, `episodes.preset.${p.key}`).replace(/^[\d–\s·]+/, ""))}
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
  preset: (typeof EPISODE_PRESETS)[number],
  opts: SitePageOpts,
  conn?: Database.Database,
): string {
  const db = conn ?? getDb();
  const win = episodeWindow({ from: preset.from, to: preset.to, asof: false }, db);
  const range = rangeLabel(preset.from, preset.to);
  const label = t(locale, `episodes.preset.${preset.key}`);

  const nber = win.recessions.length
    ? win.recessions
        .map(
          (r) =>
            `<li>${esc(t(locale, "episodes.nber", { period: `${r.start}–${r.end}`, caught: r.caught, total: win.forecastCount }))}</li>`,
        )
        .join("")
    : `<li>${esc(t(locale, "episodes.nber_none"))}</li>`;

  const body = `<div class="prose">
  <h1>${esc(t(locale, "site.episode_title", { range }))}</h1>
  <p>${esc(label)} · ${esc(t(locale, "episodes.mode_latest"))}</p>
  <ul class="audit-list">${nber}</ul>
  ${
    win.hits.length
      ? `<p>${esc(t(locale, "episodes.signal_header"))}</p>${hitsTable(win.hits, locale)}`
      : `<p>${esc(t(locale, "episodes.quiet"))}</p>`
  }
  <div class="disclaimer">${esc(t(locale, "episodes.note", { mode: t(locale, "episodes.mode_latest") }))}</div>
  <p><a href="../">${esc(t(locale, "site.episodes_title"))}</a> · <a href="../../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(
    locale,
    `${t(locale, "site.episode_title", { range })} — ${label.replace(/^[\d–\s·]+/, "")}`,
    body,
    {
      ...opts,
      description: t(locale, "site.episode_desc", { range }),
      pagePath: `/episodes/${episodeSlug(preset.from, preset.to)}/`,
    },
  );
}

/** Index + one page per preset. Returns [relpath, html][]. */
export function episodePages(
  locale: string,
  base: string,
  opts: SitePageOpts,
  conn?: Database.Database,
): [string, string][] {
  const db = conn ?? getDb();
  const pages: [string, string][] = [[`${base}/index.html`, episodesIndexHtml(locale, opts)]];
  for (const p of EPISODE_PRESETS) {
    pages.push([
      `${base}/${episodeSlug(p.from, p.to)}/index.html`,
      episodePageHtml(locale, p, opts, db),
    ]);
  }
  return pages;
}
