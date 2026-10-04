import { t } from "../publish/render/i18n.js";
import { renderArticleBody } from "./articles.js";
import { esc, pageShell, botCta, type SitePageOpts } from "./html.js";

/**
 * Glossary pages (SEO long-tail): plain-language explainers for the
 * concepts behind the monitor, grouped into topical clusters. Every
 * term stays inside the project's niche — recession mechanics, the
 * indicators we track, data methodology — and cross-links to the live
 * /signals/ and /episodes/ pages it relates to. Editorial content only:
 * no gated data.
 */

export interface GlossaryTerm {
  key: string;
  /** /signals/<key>/ pages this term explains. */
  signals?: string[];
  /** /episodes/<slug>/ pages worth linking (e.g. double dip → 1981-82). */
  episodes?: string[];
  /** Other glossary keys to cross-link as "see also". */
  seeAlso?: string[];
}

export const GLOSSARY: { cluster: string; terms: GlossaryTerm[] }[] = [
  {
    cluster: "core",
    terms: [
      { key: "composite_score", seeAlso: ["leading_vs_coincident", "base_rate"] },
      { key: "leading_vs_coincident", seeAlso: ["composite_score", "nowcasting"] },
      { key: "nber_recession", seeAlso: ["business_cycle", "data_revisions"] },
      { key: "data_revisions", seeAlso: ["nber_recession", "seasonal_adjustment"] },
    ],
  },
  {
    cluster: "recessions",
    terms: [
      { key: "business_cycle", seeAlso: ["nber_recession", "growth_recession", "output_gap"] },
      { key: "soft_landing", episodes: ["2023-2024"], seeAlso: ["business_cycle", "yield_curve_inversion"] },
      { key: "double_dip", episodes: ["1980", "1981-1982"], seeAlso: ["business_cycle"] },
      { key: "growth_recession", seeAlso: ["business_cycle", "output_gap"] },
      { key: "output_gap", seeAlso: ["growth_recession", "business_cycle"] },
    ],
  },
  {
    cluster: "rates",
    terms: [
      { key: "yield_curve_inversion", signals: ["yield_curve_inversion", "curve_10y2y_inversion"], seeAlso: ["resteepening", "term_premium", "treasury_yield"] },
      { key: "resteepening", signals: ["yield_curve_resteepening"], seeAlso: ["yield_curve_inversion", "bear_steepener"] },
      { key: "bear_steepener", seeAlso: ["resteepening", "yield_curve_inversion"] },
      { key: "treasury_yield", seeAlso: ["yield_curve_inversion", "term_premium", "fed_funds_rate"] },
      { key: "term_premium", seeAlso: ["treasury_yield", "yield_curve_inversion"] },
      { key: "fed_funds_rate", seeAlso: ["yield_curve_inversion", "qe_qt"] },
      { key: "qe_qt", seeAlso: ["fed_funds_rate", "term_premium", "liquidity"] },
    ],
  },
  {
    cluster: "credit",
    terms: [
      { key: "credit_spread", signals: ["bbb_spread"], seeAlso: ["high_yield", "credit_crunch"] },
      { key: "high_yield", signals: ["hy_spread"], seeAlso: ["credit_spread", "credit_crunch"] },
      { key: "credit_crunch", episodes: ["1990-1991", "2007-2009"], seeAlso: ["credit_spread", "lending_standards", "liquidity"] },
      { key: "lending_standards", signals: ["sloos_tightening"], seeAlso: ["credit_crunch", "credit_spread"] },
      { key: "nfci", signals: ["nfci_tightening", "stlfsi_stress"], seeAlso: ["credit_spread", "liquidity"] },
      { key: "liquidity", seeAlso: ["credit_crunch", "qe_qt", "nfci"] },
    ],
  },
  {
    cluster: "labor",
    terms: [
      { key: "sahm_rule", signals: ["sahm_rule", "sahm_states"], seeAlso: ["u3_u6", "leading_vs_coincident"] },
      { key: "jobless_claims", signals: ["claims_trend", "continued_claims_rise"], seeAlso: ["sahm_rule", "u3_u6"] },
      { key: "payrolls", seeAlso: ["jobless_claims", "u3_u6"] },
      { key: "u3_u6", seeAlso: ["sahm_rule", "payrolls"] },
      { key: "jolts_quits", signals: ["jolts_flows"], seeAlso: ["payrolls", "temp_help"] },
      { key: "temp_help", signals: ["temp_help_decline"], seeAlso: ["payrolls", "jolts_quits"] },
    ],
  },
  {
    cluster: "activity",
    terms: [
      { key: "industrial_production", signals: ["indpro_decline", "cfnaid_weak"], seeAlso: ["durable_goods", "ism_pmi"] },
      { key: "housing_permits", signals: ["permits_decline", "housing_starts_decline"], seeAlso: ["durable_goods", "fed_funds_rate"] },
      { key: "durable_goods", signals: ["durable_orders_decline"], seeAlso: ["industrial_production", "housing_permits"] },
      { key: "ism_pmi", seeAlso: ["industrial_production", "hard_vs_soft_data"] },
      { key: "gdp_vs_gdi", seeAlso: ["nber_recession", "data_revisions"] },
    ],
  },
  {
    cluster: "inflation",
    terms: [
      { key: "cpi_vs_pce", seeAlso: ["core_inflation", "breakevens"] },
      { key: "core_inflation", seeAlso: ["cpi_vs_pce", "fed_funds_rate"] },
      { key: "breakevens", seeAlso: ["treasury_yield", "cpi_vs_pce"] },
      { key: "stagflation", episodes: ["1973-1975"], seeAlso: ["cpi_vs_pce", "business_cycle"] },
    ],
  },
  {
    cluster: "method",
    terms: [
      { key: "seasonal_adjustment", seeAlso: ["data_revisions", "payrolls"] },
      { key: "nowcasting", signals: ["sahm_rule", "chauvet_piger"], seeAlso: ["leading_vs_coincident"] },
      { key: "base_rate", seeAlso: ["composite_score", "nyfed_prob"] },
      { key: "hard_vs_soft_data", seeAlso: ["ism_pmi", "seasonal_adjustment"] },
      { key: "nyfed_prob", signals: ["nyfed_recession_prob"], seeAlso: ["base_rate", "composite_score"] },
    ],
  },
];

const ALL_TERMS: GlossaryTerm[] = GLOSSARY.flatMap((c) => c.terms);
const KNOWN = new Set(ALL_TERMS.map((t) => t.key));

/** Glossary term key that explains a given signal (for signal→glossary links). */
export function termForSignal(signalKey: string): string | null {
  return ALL_TERMS.find((tm) => tm.signals?.includes(signalKey))?.key ?? null;
}

function linkList(keys: string[], hrefFor: (k: string) => string, labelFor: (k: string) => string): string {
  const items = keys
    .filter((k) => labelFor(k))
    .map((k) => `<li><a href="${hrefFor(k)}">${esc(labelFor(k))}</a></li>`)
    .join("");
  return items ? `<ul class="audit-list">${items}</ul>` : "";
}

export function glossaryIndexHtml(locale: string, opts: SitePageOpts): string {
  const blocks = GLOSSARY.map(
    (c) =>
      `<h3>${esc(t(locale, `site.glossary_cluster.${c.cluster}`))}</h3>` +
      `<ul class="audit-list">${c.terms
        .map((tm) => `<li><a href="${tm.key}/">${esc(t(locale, `glossary.${tm.key}.title`))}</a></li>`)
        .join("")}</ul>`,
  ).join("\n");

  const termSetLd = opts.siteUrl
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "DefinedTermSet",
        name: t(locale, "site.glossary_title"),
        url: `${opts.siteUrl.replace(/\/$/, "")}${opts.fallback === locale ? "" : `/${locale}`}/glossary/`,
        hasDefinedTerm: ALL_TERMS.map((tm) => ({
          "@type": "DefinedTerm",
          name: t(locale, `glossary.${tm.key}.title`),
        })),
      })}</script>`
    : "";

  const body = `<div class="prose">
  <h1>${esc(t(locale, "site.glossary_title"))}</h1>
  <p>${esc(t(locale, "site.glossary_intro"))}</p>
  ${blocks}
  ${botCta(locale, opts.bot)}
  <p><a href="../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, t(locale, "site.glossary_title"), body, {
    ...opts,
    description: t(locale, "site.glossary_intro"),
    pagePath: "/glossary/",
    extraHead: termSetLd,
  });
}

function termHtml(term: GlossaryTerm, locale: string, opts: SitePageOpts): string {
  const title = t(locale, `glossary.${term.key}.title`);

  const relatedSignals = term.signals?.length
    ? `<h3>${esc(t(locale, "site.glossary_related_signals"))}</h3>` +
      linkList(
        term.signals,
        (k) => `../../signals/${k}/`,
        (k) => t(locale, `signal.${k}.name`),
      )
    : "";
  const relatedEpisodes = term.episodes?.length
    ? `<h3>${esc(t(locale, "site.glossary_related_episodes"))}</h3>` +
      linkList(
        term.episodes,
        (k) => `../../episodes/${k}/`,
        (k) => k,
      )
    : "";
  const seeAlso = term.seeAlso?.length
    ? `<h3>${esc(t(locale, "site.glossary_see_also"))}</h3>` +
      linkList(
        term.seeAlso.filter((k) => KNOWN.has(k)),
        (k) => `../${k}/`,
        (k) => t(locale, `glossary.${k}.title`),
      )
    : "";

  const termLd = opts.siteUrl
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "DefinedTerm",
        name: title,
        description: t(locale, `glossary.${term.key}.desc`),
        inDefinedTermSet: {
          "@type": "DefinedTermSet",
          name: t(locale, "site.glossary_title"),
        },
      })}</script>`
    : "";

  const body = `<div class="prose">
  <h1>${esc(title)}</h1>
  ${renderArticleBody(t(locale, `glossary.${term.key}.body`))}
  ${relatedSignals}
  ${relatedEpisodes}
  ${seeAlso}
  ${botCta(locale, opts.bot)}
  <p><a href="../">${esc(t(locale, "site.glossary_title"))}</a> · <a href="../../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, title, body, {
    ...opts,
    description: t(locale, `glossary.${term.key}.desc`),
    pagePath: `/glossary/${term.key}/`,
    extraHead: termLd,
  });
}

export function glossaryPages(
  locale: string,
  base: string,
  opts: SitePageOpts,
): [string, string][] {
  const pages: [string, string][] = [[`${base}/index.html`, glossaryIndexHtml(locale, opts)]];
  for (const tm of ALL_TERMS) {
    pages.push([`${base}/${tm.key}/index.html`, termHtml(tm, locale, opts)]);
  }
  return pages;
}
