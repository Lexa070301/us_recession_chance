import { getConfig, getSeriesDef } from "../config/load.js";
import type { EvaluatorDef, SignalDef } from "../config/schema.js";
import { t } from "../publish/render/i18n.js";
import { esc, pageShell, botCta, type SitePageOpts } from "./html.js";

const FRED_SERIES = "https://fred.stlouisfed.org/series/";

/** Compact JSON view of an evaluator — honest rule text; long key lists are
 * summarized (sahm_states carries 51 state series). */
export function evalJson(ev: EvaluatorDef): string {
  const out: Record<string, unknown> = { type: ev.type };
  if ("params" in ev && ev.params) {
    const p = { ...(ev.params as Record<string, unknown>) };
    if (Array.isArray(p.keys)) p.keys = `${p.keys.length} series`;
    Object.assign(out, p);
  }
  if ("branches" in ev) {
    out.branches = ev.branches.map((b: EvaluatorDef) => JSON.parse(evalJson(b)));
  }
  return JSON.stringify(out);
}

const BLOCK_ORDER = ["financial", "credit", "housing", "labor", "composite", "nowcast"];

function signalSection(def: SignalDef, locale: string): string {
  const src = getSeriesDef(def.input.key);
  const fred = src?.series_id ? `${FRED_SERIES}${src.series_id}` : null;
  const meta = [
    `${t(locale, "site.method_weight")} ${def.weight}`,
    fred ? `<a href="${esc(fred)}">${esc(src!.series_id!)}</a>` : (src?.key ?? def.input.key),
    `<code>${esc(evalJson(def.evaluator))}</code>`,
  ].join(" · ");
  return `<div class="sig">
    <h3>${esc(t(locale, `signal.${def.key}.name`))}</h3>
    <div class="meta">${meta}</div>
    <p>${esc(t(locale, `signal.${def.key}.desc`))}</p>
  </div>`;
}

function paragraphs(text: string): string {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `<p>${esc(s)}</p>`)
    .join("\n");
}

/** Methodology page — public signal catalog + scoring rules + data honesty
 * (mirrors /guide in the bot; SEO + trust surface per PLAN2 §2). */
export function methodHtml(locale: string, opts: SitePageOpts): string {
  const cfg = getConfig();
  const comp = cfg.model.composite;

  const blocks = BLOCK_ORDER.map((block) => {
    const defs = cfg.signals.filter((d) => d.block === block);
    if (!defs.length) return "";
    return `<h3>${esc(t(locale, `site.block_${block}`))}</h3>` + defs.map((d) => signalSection(d, locale)).join("\n");
  }).join("\n");

  const bandsRows = comp.bands
    .map(
      (b) =>
        `<tr><td>${esc(t(locale, `bucket.${b.bucket}`))}</td><td>${b.min}–${b.max > 900 ? "∞" : b.max}</td><td>${esc(b.prob_label)}</td></tr>`,
    )
    .join("");

  const body = `<div class="prose">
  <h1>${esc(t(locale, "site.method_title"))}</h1>
  ${paragraphs(t(locale, "site.method_intro"))}

  <h3>${esc(t(locale, "site.method_scoring"))}</h3>
  <p><code>score = Σ (weight × state)</code> — watch ×${comp.state_weight.watch}, warning ×${comp.state_weight.warning}, critical ×${comp.state_weight.critical}</p>
  <table class="rules">${bandsRows}</table>
  <p>${esc(comp.base_rate_label)}</p>

  <h3>${esc(t(locale, "site.method_signals"))}</h3>
  ${blocks}

  <h3>${esc(t(locale, "site.method_data"))}</h3>
  ${paragraphs(t(locale, "site.method_data_text"))}

  <div class="disclaimer">${esc(t(locale, "site.disclaimer"))}</div>
  ${botCta(locale, opts.bot)}
  <p><a href="../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, t(locale, "site.method_title"), body, {
    ...opts,
    description: t(locale, "site.description"),
    pagePath: "/method/",
  });
}
