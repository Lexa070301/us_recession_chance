import type Database from "better-sqlite3";
import { getDb } from "../data/db.js";
import { t } from "../publish/render/i18n.js";
import { scoreScaleMax } from "../signals/score.js";
import { renderArticleBody } from "./articles.js";
import { esc, pageShell, type SitePageOpts } from "./html.js";

/**
 * /history/ — full composite-score record. Snapshots accumulate one per
 * monitor run, so this page grows into a public time series of risk.
 */

interface Snapshot {
  ts: string;
  score: number;
  bucket: string;
}

const BUCKET_COLOR: Record<string, string> = {
  low: "#4ade80",
  elevated: "#f59e0b",
  high: "#f97316",
  severe: "#ef4444",
};

function getSnapshots(conn?: Database.Database): Snapshot[] {
  const db = conn ?? getDb();
  return db
    .prepare("SELECT ts, score, bucket FROM composite_snapshots ORDER BY id ASC")
    .all() as Snapshot[];
}

export function historyHtml(
  locale: string,
  opts: SitePageOpts,
  conn?: Database.Database,
): string {
  const snaps = getSnapshots(conn);
  const max = scoreScaleMax();

  const bars = snaps.length
    ? `<div class="spark" style="height:160px">${snaps
        .map((s) => {
          const h = Math.max(2, Math.round((Math.min(s.score, max) / max) * 100));
          const c = BUCKET_COLOR[s.bucket] ?? "#334155";
          return `<div class="bar" style="height:${h}%;background:${c}" title="${esc(s.ts.slice(0, 10))} · ${s.score.toFixed(1)}"></div>`;
        })
        .join("")}</div>`
    : `<div class="spark empty">${esc(t(locale, "site.history_empty"))}</div>`;

  const rows = snaps
    .slice(-60)
    .reverse()
    .map(
      (s) =>
        `<tr><td>${esc(s.ts.slice(0, 16))}</td>` +
        `<td class="val">${s.score.toFixed(1)}</td>` +
        `<td class="st"><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${BUCKET_COLOR[s.bucket] ?? "#64748b"};margin-right:8px"></span>${esc(t(locale, `bucket.${s.bucket}`))}</td></tr>`,
    )
    .join("");

  const body = `<div class="prose">
  <h1>${esc(t(locale, "site.history_title"))}</h1>
  ${renderArticleBody(t(locale, "site.history_intro"))}
  ${bars}
  <h3>${esc(t(locale, "site.history_recent"))}</h3>
  ${rows ? `<table class="sig-table">${rows}</table>` : `<p>${esc(t(locale, "site.history_empty"))}</p>`}
  <p><a href="../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, t(locale, "site.history_title"), body, {
    ...opts,
    description: t(locale, "site.history_desc"),
    pagePath: "/history/",
  });
}
