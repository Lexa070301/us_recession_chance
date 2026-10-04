import { t } from "../publish/render/i18n.js";
import { renderArticleBody } from "./articles.js";
import { esc, pageShell, type SitePageOpts } from "./html.js";

/**
 * Glossary pages (SEO long-tail): plain-language explainers for the
 * concepts behind the signals. Editorial content only — no gated data.
 */

export const GLOSSARY_TERMS = [
  "yield_curve_inversion",
  "sahm_rule",
  "nber_recession",
  "credit_spread",
  "nfci",
  "leading_vs_coincident",
  "data_revisions",
  "composite_score",
] as const;

export function glossaryIndexHtml(locale: string, opts: SitePageOpts): string {
  const list = GLOSSARY_TERMS.map(
    (k) => `<li><a href="${k}/">${esc(t(locale, `glossary.${k}.title`))}</a></li>`,
  ).join("\n");

  const body = `<div class="prose">
  <h1>${esc(t(locale, "site.glossary_title"))}</h1>
  <p>${esc(t(locale, "site.glossary_intro"))}</p>
  <ul class="audit-list">${list}</ul>
  <p><a href="../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, t(locale, "site.glossary_title"), body, {
    ...opts,
    description: t(locale, "site.glossary_intro"),
    pagePath: "/glossary/",
  });
}

function termHtml(
  key: (typeof GLOSSARY_TERMS)[number],
  locale: string,
  opts: SitePageOpts,
): string {
  const title = t(locale, `glossary.${key}.title`);
  const body = `<div class="prose">
  <h1>${esc(title)}</h1>
  ${renderArticleBody(t(locale, `glossary.${key}.body`))}
  <p><a href="../">${esc(t(locale, "site.glossary_title"))}</a> · <a href="../../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, title, body, {
    ...opts,
    description: t(locale, `glossary.${key}.desc`),
    pagePath: `/glossary/${key}/`,
  });
}

export function glossaryPages(
  locale: string,
  base: string,
  opts: SitePageOpts,
): [string, string][] {
  const pages: [string, string][] = [[`${base}/index.html`, glossaryIndexHtml(locale, opts)]];
  for (const k of GLOSSARY_TERMS) {
    pages.push([`${base}/${k}/index.html`, termHtml(k, locale, opts)]);
  }
  return pages;
}
