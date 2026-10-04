import type { DashboardData } from "./dataJson.js";
import { scoreScaleMax } from "../signals/score.js";
import { t } from "../publish/render/i18n.js";

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface SitePageOpts {
  bot?: string;
  feedHref?: string;
  siteUrl?: string;
  locales?: string[];
  fallback?: string;
  /** Root-relative path of the page, e.g. "/" or "/method/" — canonical link. */
  pagePath?: string;
}

const BASE_CSS = `
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; }
  body { background: #0d1524; color: #e5e7eb; font-family: -apple-system, "Segoe UI", Roboto, Inter, sans-serif; min-height: 100vh; display: flex; justify-content: center; }
  main { width: 100%; max-width: 760px; padding: 48px 24px 64px; }
  header { display: flex; justify-content: space-between; align-items: baseline; color: #64748b; font-size: 14px; letter-spacing: 3px; margin-bottom: 56px; }
  header .date { letter-spacing: 1px; }
  header nav { letter-spacing: 1px; }
  h1.bucket { font-size: 64px; font-weight: 800; letter-spacing: 2px; }
  .sub { color: #94a3b8; font-size: 22px; margin-top: 8px; }
  .spark { display: flex; align-items: flex-end; gap: 3px; height: 96px; margin-top: 40px; }
  .spark .bar { flex: 1; min-height: 4px; border-radius: 2px; background: #334155; }
  .spark.empty { color: #64748b; align-items: center; }
  .trend-label { color: #64748b; font-size: 13px; margin-top: 8px; text-align: right; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 36px; }
  .chip { display: flex; align-items: center; gap: 10px; background: #16233b; border-radius: 12px; padding: 10px 16px; font-size: 15px; }
  .chip .dot { width: 10px; height: 10px; border-radius: 50%; }
  .chip .val { color: #94a3b8; }
  .nowcast { color: #94a3b8; font-size: 15px; margin-top: 36px; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #16233b; color: #64748b; font-size: 14px; display: flex; flex-wrap: wrap; gap: 18px; }
  a { color: #7dd3fc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  h2 { font-size: 15px; letter-spacing: 2px; text-transform: uppercase; color: #64748b; margin: 44px 0 14px; }
  .sig-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .sig-table td { padding: 8px 6px; border-bottom: 1px solid #16233b; vertical-align: middle; }
  .sig-table .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 10px; }
  .sig-table .val { color: #94a3b8; white-space: nowrap; text-align: right; }
  .sig-table .st { color: #64748b; font-size: 12px; text-align: right; white-space: nowrap; }
  .sig-table .st.hdr { text-align: left; letter-spacing: 1px; text-transform: uppercase; font-size: 11px; padding-top: 18px; }
  .cta { background: #16233b; border-radius: 12px; padding: 20px 22px; margin-top: 44px; }
  .cta h2 { margin: 0 0 10px; }
  .cta ul { margin: 0; padding-left: 18px; color: #94a3b8; font-size: 14px; line-height: 1.8; }
  .cta .go { display: inline-block; margin-top: 14px; }
  .prose p { color: #94a3b8; font-size: 15px; line-height: 1.7; margin: 14px 0; }
  .prose h1 { font-size: 34px; margin-bottom: 8px; }
  .prose h3 { font-size: 16px; margin: 26px 0 6px; color: #e5e7eb; }
  .prose code { background: #16233b; border-radius: 6px; padding: 2px 7px; font-size: 12px; color: #a5d6ff; word-break: break-all; }
  .prose table.rules { border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  .prose table.rules td { border: 1px solid #16233b; padding: 6px 12px; }
  .prose .sig h3 { margin-bottom: 2px; }
  .prose .sig .meta { color: #64748b; font-size: 13px; margin-bottom: 18px; }
  .prose pre { background: #16233b; border-radius: 10px; padding: 18px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; }
  .audit-list { list-style: none; padding: 0; }
  .audit-list li { padding: 12px 0; border-bottom: 1px solid #16233b; }
  .audit-list .when { color: #64748b; font-size: 13px; }
  .disclaimer { color: #64748b; font-size: 12px; margin-top: 40px; }
  .lang { display: inline-flex; gap: 8px; }
  .lang a.on { color: #e5e7eb; }
  .lang a.off { color: #475569; }
`;

const STATE_DOT: Record<string, string> = {
  ok: "#4ade80",
  watch: "#f59e0b",
  warning: "#f97316",
  critical: "#ef4444",
  none: "#475569",
};

export function pageShell(
  locale: string,
  title: string,
  body: string,
  opts: SitePageOpts & { description?: string; extraHead?: string },
): string {
  const siteUrl = (opts.siteUrl ?? "").replace(/\/$/, "");
  const locales = opts.locales ?? [locale];
  const fallback = opts.fallback ?? locale;
  const path = opts.pagePath ?? "/";
  const hrefFor = (l: string) => (l === fallback ? `${siteUrl}${path}` : `${siteUrl}/${l}${path}`);
  const pageUrl = siteUrl ? hrefFor(locale) : "";
  const canonical = siteUrl ? `<link rel="canonical" href="${esc(pageUrl)}">` : "";
  const hreflang = siteUrl
    ? locales
        .map((l) => `<link rel="alternate" hreflang="${esc(l)}" href="${esc(hrefFor(l))}">`)
        .join("\n") +
      `\n<link rel="alternate" hreflang="x-default" href="${esc(hrefFor(fallback))}">`
    : "";
  const desc = opts.description ? `<meta name="description" content="${esc(opts.description)}">` : "";
  const og = siteUrl
    ? `<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
${opts.description ? `<meta property="og:description" content="${esc(opts.description)}">` : ""}
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:image" content="${esc(siteUrl)}/card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">`
    : "";
  const jsonLd = siteUrl
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Dataset",
        name: title,
        description: opts.description ?? "",
        url: siteUrl,
        creator: { "@type": "Organization", name: title },
        distribution: [
          {
            "@type": "DataDownload",
            encodingFormat: "application/json",
            contentUrl: `${siteUrl}/data.json`,
          },
        ],
      })}</script>`
    : "";
  // Home page of each locale. With siteUrl → absolute (Pages hosts under a
  // project path, so bare "/ru/" would escape the repo subdir). Without it →
  // relative ("ru/" from root, "../" from a locale subpage).
  const homeHref = (l: string): string => {
    if (siteUrl) return l === fallback ? `${siteUrl}/` : `${siteUrl}/${l}/`;
    if (l === locale) return "./";
    return l === fallback ? "../" : `${l}/`;
  };
  const langNav =
    locales.length > 1
      ? `<span class="lang">${locales
          .map(
            (l) =>
              `<a class="${l === locale ? "on" : "off"}" href="${esc(homeHref(l))}">${l.toUpperCase()}</a>`,
          )
          .join(" · ")}</span>`
      : "";
  return `<!doctype html>
<html lang="${esc(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${desc}
${canonical}
${hreflang}
${og}
${opts.feedHref ? `<link rel="alternate" type="application/atom+xml" href="${esc(opts.feedHref)}" title="${esc(title)} (${esc(locale)})">` : ""}
${jsonLd}
${opts.extraHead ?? ""}
<style>${BASE_CSS}</style>
</head>
<body>
<main>
${body}
${langNav ? `<footer style="border:none;margin-top:24px;padding-top:0">${langNav}</footer>` : ""}
</main>
</body>
</html>`;
}

function sparkbars(trend: [string, number][], accent: string): string {
  const max = scoreScaleMax();
  const pts = trend.slice(-60).map((p) => p[1]);
  if (!pts.length) return `<div class="spark empty">—</div>`;
  const bars = pts
    .map((v, i) => {
      const h = Math.max(4, Math.round((Math.min(v, max) / max) * 100));
      const last = i === pts.length - 1;
      return `<div class="bar${last ? " last" : ""}" style="height:${h}%${last ? `;background:${accent}` : ""}"></div>`;
    })
    .join("");
  return `<div class="spark">${bars}</div>`;
}

function chip(e: { name: string; state: string; value: string }): string {
  const dot = STATE_DOT[e.state] ?? "#94a3b8";
  return `<div class="chip"><span class="dot" style="background:${dot}"></span>${esc(e.name)}<span class="val">${esc(e.value)}</span></div>`;
}

/** Static dashboard page — no JS deps, mirrors the PNG card layout on top
 * and adds the coverage table + bot CTA below (landing's own job). */
export function indexHtml(
  d: DashboardData,
  locale: string,
  opts: SitePageOpts,
): string {
  const L = d.labels;
  const modelLine =
    (d.model_prob_label
      ? `${esc(d.model_prob_label)} · ${esc(L.score)} ${d.score.toFixed(1)}`
      : `${esc(L.score)} ${d.score.toFixed(1)}`) +
    (d.score_next ? ` · ${esc(d.score_next)}` : "");
  const nowcastLine = d.nowcast.length
    ? d.nowcast.map((n) => `${esc(n.name)} ${esc(n.value)}`).join(" · ")
    : esc(L.nowcast_calm);
  const updated = new Date(d.generated_at).toISOString().slice(0, 16).replace("T", " ");

  const sigRows = (list: typeof d.signals) =>
    list
      .map(
        (s) =>
          `<tr><td><span class="dot" style="background:${STATE_DOT[s.state] ?? STATE_DOT.none}"></span>${esc(s.name)}</td>` +
          `<td class="val">${esc(s.value)}</td>` +
          `<td class="st">${esc(s.state === "none" ? L.state_none : t(locale, `severity.${s.state}`))}</td></tr>`,
      )
      .join("");

  const forecastRows = sigRows(d.signals.filter((s) => s.block !== "nowcast"));
  const nowcastRows = sigRows(d.signals.filter((s) => s.block === "nowcast"));

  const ctaItems = L.cta_items
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `<li>${esc(s)}</li>`)
    .join("");
  const botLink = opts.bot ? `https://t.me/${esc(opts.bot)}` : null;

  const body = `
  <header><span>${esc(L.title.toUpperCase())}</span><span class="date">${esc(d.generated_at.slice(0, 10))}</span></header>
  <h1 class="bucket" style="color:${esc(d.bucket_color)}">${esc(d.bucket.toUpperCase())}</h1>
  <div class="sub">${modelLine}</div>
  ${sparkbars(d.trend, d.bucket_color)}
  <div class="trend-label">${esc(L.trend_90d)}</div>
  ${d.active.length ? `<div class="chips">${d.active.map(chip).join("")}</div>` : ""}
  <div class="nowcast">${esc(L.nowcast)}: ${nowcastLine}</div>

  <h2>${esc(L.signals_title)}</h2>
  <table class="sig-table">
    ${forecastRows}
    ${nowcastRows ? `<tr><td class="st hdr" colspan="3">${esc(L.nowcast)}</td></tr>${nowcastRows}` : ""}
  </table>

  ${
    botLink
      ? `<div class="cta">
    <h2>${esc(L.cta_title)}</h2>
    <ul>${ctaItems}</ul>
    <a class="go" href="${botLink}">@${esc(opts.bot!)} →</a>
  </div>`
      : ""
  }

  <footer>
    <span>${esc(L.updated)}: ${esc(updated)} UTC</span>
    <a href="method/">${esc(L.method_link)}</a>
    <a href="audit/">${esc(L.audit_link)}</a>
    ${opts.bot ? `<a href="${botLink}">@${esc(opts.bot)}</a>` : ""}
    ${opts.feedHref ? `<a href="${esc(opts.feedHref)}">RSS</a>` : ""}
  </footer>
  <div class="disclaimer">${esc(t(locale, "site.disclaimer"))}</div>`;

  const title = `${L.title} — ${L.subtitle}: ${d.bucket.toUpperCase()}`;
  return pageShell(locale, title, body, {
    ...opts,
    description: L.description,
    pagePath: "/",
  });
}
