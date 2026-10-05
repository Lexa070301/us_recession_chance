import { getConfig } from "../config/load.js";
import { getDb } from "../data/db.js";
import { alreadySyndicated, markSyndicated } from "../publish/syndication/repo.js";
import { syndicatePosts } from "../publish/syndication/index.js";
import { clip, syndicationLocales, type ExternalPost } from "../publish/syndication/types.js";
import { t } from "../publish/render/i18n.js";
import { GLOSSARY } from "../site/glossary.js";
import { SITE_EPISODES } from "../site/episodes.js";

/**
 * "Fact of the week" (PLAN2 §3): evergreen posts built from the fact boxes
 * in glossary/episode articles, fanned out to all external venues via the
 * normal syndication pipeline. One fact per locale per run; rotation state
 * lives in `syndications` under the pseudo-venue "fact" so a fact is used
 * exactly once — the backlog (~a year of weekly posts) never repeats.
 *
 * Publication environment only (SYNDICATION_ENABLED) — same gate as the
 * weekly digest syndication; the server scheduler lacks the secrets, so
 * double-posting is impossible by construction.
 */

export interface Fact {
  /** Stable rotation/dedup slug: g:<term> / e:<episode>. */
  id: string;
  /** Localized title of the source page (glossary term / episode). */
  name: string;
  /** The fact line itself, without the "> **Fact:**" marker. */
  text: string;
  /** Site-relative canonical path, e.g. /glossary/sahm_rule/. */
  path: string;
}

const FACT_RE = /^> \*\*(?:Fact|Факт):\*\*\s*(.+)$/m;

function extractFact(body: string): string | null {
  const m = FACT_RE.exec(body);
  return m ? m[1].trim() : null;
}

/** All facts in canonical rotation order for one locale. */
export function collectFacts(locale: string): Fact[] {
  const facts: Fact[] = [];
  for (const term of GLOSSARY.flatMap((c) => c.terms)) {
    const text = extractFact(t(locale, `glossary.${term.key}.body`));
    if (text) {
      facts.push({
        id: `g:${term.key}`,
        name: t(locale, `glossary.${term.key}.title`),
        text,
        path: `/glossary/${term.key}/`,
      });
    }
  }
  for (const ep of SITE_EPISODES) {
    const text = extractFact(t(locale, `site.article.${ep.key}.body`));
    if (text) {
      facts.push({
        id: `e:${ep.key}`,
        name: t(locale, `site.article.${ep.key}.title`),
        text,
        path: `/episodes/${ep.from === ep.to ? ep.from : `${ep.from}-${ep.to}`}/`,
      });
    }
  }
  return facts;
}

/** First fact in rotation order not yet consumed for this locale. */
export function nextFact(
  locale: string,
  conn?: Parameters<typeof alreadySyndicated>[3],
): Fact | null {
  for (const f of collectFacts(locale)) {
    if (!alreadySyndicated("fact", locale, `f:${f.id}`, conn)) return f;
  }
  return null;
}

export function buildFactPost(fact: Fact, locale: string): ExternalPost {
  const cfg = getConfig();
  const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");
  const prefix = locale === cfg.channels.defaults.fallback_locale ? "" : `/${locale}`;
  const url = siteUrl ? `${siteUrl}${prefix}${fact.path}` : undefined;
  const title = t(locale, "fact.title", { name: fact.name });
  const text = `${title}\n\n${fact.text}`;
  return {
    key: `f:${fact.id}`,
    kind: "fact",
    locale,
    title,
    text,
    url,
    variants: { short: clip(text, 240), medium: clip(text, 460) },
  };
}

export async function jobFactOfWeek(): Promise<void> {
  if (process.env.SYNDICATION_ENABLED !== "true") return;
  const db = getDb();
  for (const locale of syndicationLocales()) {
    const fact = nextFact(locale, db);
    if (!fact) {
      console.log(`[facts] ${locale}: backlog exhausted, skipping`);
      continue;
    }
    const post = buildFactPost(fact, locale);
    const res = await syndicatePosts([post], db);
    // Consume the fact only when it actually went somewhere — a total
    // failure retries the same fact next week instead of burning it.
    if (res.published > 0 || res.skipped > 0) {
      markSyndicated("fact", locale, post.key, null, db);
    }
    console.log(
      `[facts] ${locale}: ${fact.id} — published=${res.published} skipped=${res.skipped} failed=${res.failed}`,
    );
  }
}
