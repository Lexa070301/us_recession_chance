import { t } from "../publish/render/i18n.js";
import { renderArticleBody } from "./articles.js";
import { esc, pageShell, type SitePageOpts } from "./html.js";

/**
 * /about/ — what the project is, where the data comes from, how it's
 * maintained. E-E-A-T surface plus an honest independence note.
 */
export function aboutHtml(locale: string, opts: SitePageOpts): string {
  const body = `<div class="prose">
  <h1>${esc(t(locale, "site.about_title"))}</h1>
  ${renderArticleBody(t(locale, "site.about_body"))}
  <p><a href="../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, t(locale, "site.about_title"), body, {
    ...opts,
    description: t(locale, "site.about_desc"),
    pagePath: "/about/",
  });
}
