import type Database from "better-sqlite3";
import { getConfig, getSeriesDef } from "../config/load.js";
import type { SignalDef } from "../config/schema.js";
import { getDb } from "../data/db.js";
import { t } from "../publish/render/i18n.js";
import { buildDashboardData } from "./dataJson.js";
import { evalJson } from "./method.js";
import { esc, pageShell, type SitePageOpts } from "./html.js";

/**
 * Per-signal pages (SEO): current state/value, plain-language description,
 * the exact scoring rule, FRED source link, and an editorial paragraph on
 * what the indicator measures and why it leads. Hit-rate statistics stay
 * behind the bot's /analytics — pages carry context, not pro metrics.
 */

const FRED_SERIES = "https://fred.stlouisfed.org/series/";
const BLOCK_ORDER = ["financial", "credit", "housing", "labor", "composite", "nowcast"];

const SEV_COLOR: Record<string, string> = {
  ok: "#4ade80",
  watch: "#f59e0b",
  warning: "#f97316",
  critical: "#ef4444",
  none: "#475569",
};

function fredLink(def: SignalDef): string | null {
  const src = getSeriesDef(def.input.key);
  return src?.series_id ? `${FRED_SERIES}${src.series_id}` : null;
}

export function signalsIndexHtml(
  locale: string,
  opts: SitePageOpts,
  conn?: Database.Database,
): string {
  const cfg = getConfig();
  const d = buildDashboardData(locale, conn ?? getDb());
  const stateByKey = new Map(d.signals.map((s) => [s.key, s]));

  const blocks = BLOCK_ORDER.map((block) => {
    const defs = cfg.signals.filter((s) => s.block === block);
    if (!defs.length) return "";
    const items = defs
      .map((s) => {
        const cur = stateByKey.get(s.key);
        const dot = SEV_COLOR[cur?.state ?? "none"] ?? SEV_COLOR.none;
        return `<li><a href="${s.key}/"><span class="dot" style="background:${dot}"></span>${esc(t(locale, `signal.${s.key}.name`))}</a>` +
          `<span class="val">${esc(cur?.value ?? "")}</span></li>`;
      })
      .join("");
    return `<h3>${esc(t(locale, `site.block_${block}`))}</h3><ul class="audit-list">${items}</ul>`;
  }).join("\n");

  const body = `<div class="prose">
  <h1>${esc(t(locale, "site.signals_title"))}</h1>
  <p>${esc(t(locale, "site.signals_intro"))}</p>
  ${blocks}
  <p><a href="../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, t(locale, "site.signals_title"), body, {
    ...opts,
    description: t(locale, "site.signals_intro"),
    pagePath: "/signals/",
  });
}

function signalPageHtml(
  def: SignalDef,
  locale: string,
  opts: SitePageOpts,
  conn?: Database.Database,
): string {
  const d = buildDashboardData(locale, conn ?? getDb());
  const cur = d.signals.find((s) => s.key === def.key);
  const name = t(locale, `signal.${def.key}.name`);
  const fred = fredLink(def);
  const dot = SEV_COLOR[cur?.state ?? "none"] ?? SEV_COLOR.none;

  const meta = [
    `${t(locale, "site.block_" + def.block)}`,
    `${t(locale, "site.method_weight")} ${def.weight}`,
    fred ? `<a href="${esc(fred)}">${esc(fred.split("/").pop()!)}</a>` : def.input.key,
  ].join(" · ");

  const body = `<div class="prose">
  <h1>${esc(name)}</h1>
  <p class="meta"><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dot};margin-right:8px"></span>${esc(cur ? (cur.state === "none" ? t(locale, "site.state_none") : t(locale, `severity.${cur.state}`)) : "")} · ${esc(cur?.value ?? "")} · ${meta}</p>
  <p>${esc(t(locale, `signal.${def.key}.desc`))}</p>
  ${renderSignalCopy(def, locale)}
  <h3>${esc(t(locale, "site.method_rule"))}</h3>
  <pre>${esc(evalJson(def.evaluator))}</pre>
  ${fred ? `<p><a href="${esc(fred)}">${esc(t(locale, "site.signal_source"))} →</a></p>` : ""}
  <p><a href="../">${esc(t(locale, "site.signals_title"))}</a> · <a href="../../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, `${name} — ${t(locale, "site.title")}`, body, {
    ...opts,
    description: t(locale, `signal.${def.key}.desc`),
    pagePath: `/signals/${def.key}/`,
  });
}

/** Editorial paragraph per signal — site.signal_page.<key>, falls back
 * to block-level copy when a specific text isn't written. */
function renderSignalCopy(def: SignalDef, locale: string): string {
  const text = t(locale, `site.signal_page.${def.key}`);
  if (text === `site.signal_page.${def.key}`) return "";
  return `<p>${esc(text)}</p>`;
}

/** Index + one page per signal. [relpath, html][]. */
export function signalPages(
  locale: string,
  base: string,
  opts: SitePageOpts,
  conn?: Database.Database,
): [string, string][] {
  const db = conn ?? getDb();
  const cfg = getConfig();
  const pages: [string, string][] = [[`${base}/index.html`, signalsIndexHtml(locale, opts, db)]];
  for (const def of cfg.signals) {
    pages.push([`${base}/${def.key}/index.html`, signalPageHtml(def, locale, opts, db)]);
  }
  return pages;
}
