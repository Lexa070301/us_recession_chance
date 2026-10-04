import { t } from "../publish/render/i18n.js";
import { renderArticleBody } from "./articles.js";
import { esc, pageShell, type SitePageOpts } from "./html.js";

/**
 * FAQ page + FAQPage JSON-LD — same Q&A text drives both the visible list
 * and the structured-data block (single source, no drift). FAQ schema is
 * eligible for rich results and is a strong fit for methodology questions.
 */

const FAQ_COUNT = 8;

interface FaqItem {
  q: string;
  a: string;
}

function items(locale: string): FaqItem[] {
  const out: FaqItem[] = [];
  for (let i = 1; i <= FAQ_COUNT; i++) {
    out.push({
      q: t(locale, `site.faq.${i}.q`),
      a: t(locale, `site.faq.${i}.a`),
    });
  }
  return out;
}

export function faqHtml(locale: string, opts: SitePageOpts): string {
  const faqs = items(locale);
  const list = faqs
    .map(
      (f) => `<div class="faq-item"><h3>${esc(f.q)}</h3>${renderArticleBody(f.a)}</div>`,
    )
    .join("\n");

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a.replace(/\n+/g, " ").trim() },
    })),
  });

  const body = `<div class="prose">
  <h1>${esc(t(locale, "site.faq_title"))}</h1>
  ${list}
  <p><a href="../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, t(locale, "site.faq_title"), body, {
    ...opts,
    description: t(locale, "site.faq_desc"),
    pagePath: "/faq/",
    extraHead: `<script type="application/ld+json">${jsonLd}</script>`,
  });
}
