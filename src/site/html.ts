import type { DashboardData } from "./dataJson.js";
import { scoreScaleMax } from "../signals/score.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

const STATE_DOT: Record<string, string> = {
  ok: "#4ade80",
  watch: "#f59e0b",
  warning: "#f97316",
  critical: "#ef4444",
};

function chip(e: { name: string; state: string; value: string }): string {
  const dot = STATE_DOT[e.state] ?? "#94a3b8";
  return `<div class="chip"><span class="dot" style="background:${dot}"></span>${esc(e.name)}<span class="val">${esc(e.value)}</span></div>`;
}

/** Static dashboard page — no JS deps, mirrors the PNG card layout. */
export function indexHtml(
  d: DashboardData,
  locale: string,
  opts: { bot?: string; feedHref?: string },
): string {
  const feedHref = opts.feedHref ?? `feed-${locale}.xml`;
  const L = d.labels;
  const modelLine = d.model_prob_label
    ? `${esc(d.model_prob_label)} · ${esc(L.score)} ${d.score.toFixed(1)}`
    : `${esc(L.score)} ${d.score.toFixed(1)}`;
  const nowcastLine = d.nowcast.length
    ? d.nowcast.map((n) => `${esc(n.name)} ${esc(n.value)}`).join(" · ")
    : esc(L.nowcast_calm);
  const updated = new Date(d.generated_at).toISOString().slice(0, 16).replace("T", " ");

  return `<!doctype html>
<html lang="${esc(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(L.title)}</title>
<link rel="alternate" type="application/atom+xml" href="${esc(feedHref)}" title="US Recession Watch (${esc(locale)})">
<style>
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; }
  body { background: #0d1524; color: #e5e7eb; font-family: -apple-system, "Segoe UI", Roboto, Inter, sans-serif; min-height: 100vh; display: flex; justify-content: center; }
  main { width: 100%; max-width: 760px; padding: 48px 24px 64px; }
  header { display: flex; justify-content: space-between; align-items: baseline; color: #64748b; font-size: 14px; letter-spacing: 3px; margin-bottom: 56px; }
  header .date { letter-spacing: 1px; }
  h1.bucket { font-size: 64px; font-weight: 800; letter-spacing: 2px; color: ${esc(d.bucket_color)}; }
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
  footer a { color: #7dd3fc; text-decoration: none; }
  footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <header><span>US RECESSION WATCH</span><span class="date">${esc(d.generated_at.slice(0, 10))}</span></header>
  <h1 class="bucket">${esc(d.bucket.toUpperCase())}</h1>
  <div class="sub">${modelLine}</div>
  ${sparkbars(d.trend, d.bucket_color)}
  <div class="trend-label">${esc(L.trend_90d)}</div>
  ${d.active.length ? `<div class="chips">${d.active.map(chip).join("")}</div>` : ""}
  <div class="nowcast">${esc(L.nowcast)}: ${nowcastLine}</div>
  <footer>
    <span>${esc(L.updated)}: ${esc(updated)} UTC</span>
    ${opts.bot ? `<a href="https://t.me/${esc(opts.bot)}">@${esc(opts.bot)}</a>` : ""}
    <a href="${esc(feedHref)}">RSS</a>
  </footer>
</main>
</body>
</html>`;
}
