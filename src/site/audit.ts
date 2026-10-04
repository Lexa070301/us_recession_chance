import type Database from "better-sqlite3";
import { getDb } from "../data/db.js";
import { t } from "../publish/render/i18n.js";
import { esc, pageShell, botCta, type SitePageOpts } from "./html.js";

/**
 * Self-audit archive — public, linkable record of the weekly audit posts
 * (PLAN2 §6 trust surface). Posts ship to Telegram channels; this is the
 * same content in a citable form.
 */

interface AuditRow {
  digest_key: string;
  payload_text: string;
  sent_at: string;
}

function auditRows(locale: string, conn?: Database.Database): AuditRow[] {
  const db = conn ?? getDb();
  return db
    .prepare(
      `SELECT digest_key, payload_text, sent_at FROM deliveries
       WHERE digest_key LIKE 'a:%' AND target_type = 'channel' AND status = 'sent'
         AND locale = ? AND payload_text IS NOT NULL
       ORDER BY digest_key DESC`,
    )
    .all(locale) as AuditRow[];
}

const slug = (key: string) => key.replace(/^a:/, "").replace(/[^A-Za-z0-9_-]/g, "-");

export function auditIndexHtml(locale: string, opts: SitePageOpts, conn?: Database.Database): string {
  const rows = auditRows(locale, conn);
  const list = rows.length
    ? `<ul class="audit-list">${rows
        .map(
          (r) => `<li>
        <a href="${slug(r.digest_key)}/">${esc(r.payload_text.split("\n")[0].slice(0, 120))}</a>
        <div class="when">${esc(slug(r.digest_key))} · ${esc((r.sent_at ?? "").slice(0, 10))}</div>
      </li>`,
        )
        .join("")}</ul>`
    : `<p>${esc(t(locale, "site.audit_empty"))}</p>`;

  const body = `<div class="prose">
  <h1>${esc(t(locale, "site.audit_title"))}</h1>
  ${list}
  ${botCta(locale, opts.bot)}
  <p><a href="../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, t(locale, "site.audit_title"), body, {
    ...opts,
    description: t(locale, "site.description"),
    pagePath: "/audit/",
  });
}

/** Per-week audit page — full post text, escaped verbatim. */
/** Week slug → locales that actually have that audit page. Lets hreflang
 * point only at existing alternates (a week posted in one locale would
 * otherwise emit an alternate link to a 404). */
export function auditWeekLocales(
  locales: string[],
  conn?: Database.Database,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const loc of locales) {
    for (const r of auditRows(loc, conn)) {
      const s = slug(r.digest_key);
      map.set(s, [...(map.get(s) ?? []), loc]);
    }
  }
  return map;
}

export function auditWeekHtml(
  locale: string,
  row: AuditRow,
  opts: SitePageOpts,
): string {
  const label = slug(row.digest_key);
  const body = `<div class="prose">
  <h1>${esc(label)}</h1>
  <div class="when">${esc(t(locale, "site.audit_published"))} ${esc((row.sent_at ?? "").slice(0, 10))}</div>
  <pre>${esc(row.payload_text)}</pre>
  ${botCta(locale, opts.bot)}
  <p><a href="../">${esc(t(locale, "site.back"))}</a></p>
</div>`;

  return pageShell(locale, `${t(locale, "site.audit_title")} — ${label}`, body, {
    ...opts,
    pagePath: `/audit/${label}/`,
  });
}

/** All audit pages to write: index + one per week. Returns [relpath, html].
 * `weekLocales` overrides per-week hreflang alternates (see auditWeekLocales). */
export function auditPages(
  locale: string,
  base: string,
  opts: SitePageOpts,
  conn?: Database.Database,
  weekLocales?: Map<string, string[]>,
): [string, string][] {
  const rows = auditRows(locale, conn);
  const pages: [string, string][] = [[`${base}/index.html`, auditIndexHtml(locale, opts, conn)]];
  for (const r of rows) {
    const s = slug(r.digest_key);
    const weekOpts = weekLocales?.get(s)
      ? { ...opts, locales: weekLocales.get(s) }
      : opts;
    pages.push([`${base}/${s}/index.html`, auditWeekHtml(locale, r, weekOpts)]);
  }
  return pages;
}
