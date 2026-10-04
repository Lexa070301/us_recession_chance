import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb } from "../src/data/db.js";
import { insertCompositeSnapshot } from "../src/data/repositories/signalState.js";
import { renderSite } from "../src/site/render.js";
import { buildDashboardData, dashboardDataSchema } from "../src/site/dataJson.js";

process.env.FRED_API_KEY ??= "test-key";

describe("site", () => {
  it("buildDashboardData validates against the zod schema", () => {
    const db = createTestDb();
    const data = buildDashboardData("en", db);
    expect(() => dashboardDataSchema.parse(data)).not.toThrow();
    expect(data.bucket).toBe("low");
    expect(data.labels.title).toBeTruthy();
  });

  it("trend carries [ts, score] pairs from composite_snapshots (regression)", () => {
    const db = createTestDb();
    insertCompositeSnapshot(6.4, "moderate", "p", {}, db);
    insertCompositeSnapshot(6.9, "moderate", "p", {}, db);
    const data = buildDashboardData("en", db);
    expect(data.trend).toHaveLength(2);
    expect(Array.isArray(data.trend[0])).toBe(true);
    expect(data.trend[0]).toHaveLength(2);
    expect(typeof data.trend[1][1]).toBe("number");
    expect(data.trend[1][1]).toBeCloseTo(6.9);
  });

  it("signals lists every configured signal incl. never-evaluated ones", () => {
    const db = createTestDb();
    const data = buildDashboardData("en", db);
    expect(data.signals.length).toBeGreaterThan(10);
    // fresh DB → nothing evaluated → all "none"
    expect(data.signals.every((s) => s.state === "none")).toBe(true);
    expect(data.signals.some((s) => s.block === "nowcast")).toBe(true);
  });

  it("renderSite writes html, feeds and data.json for each locale", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO deliveries (digest_key, target_type, target_id, locale, status, payload_text, sent_at)
       VALUES ('a:2026-W40', 'channel', '@c', 'en', 'sent', 'AUDIT week 40\nscore verdict', '2026-10-01 13:00:00')`,
    ).run();
    const out = mkdtempSync(join(tmpdir(), "site-"));
    const prev = process.env.SITE_URL;
    process.env.SITE_URL = "https://example.test/site";
    const written = renderSite(out, db);
    process.env.SITE_URL = prev;
    expect(written).toContain("index.html");
    expect(written).toContain("data.json");
    expect(written).toContain("feed-en.xml");
    expect(written).toContain("feed-ru.xml");
    expect(written).toContain(".nojekyll");
    expect(written).toContain("ru/index.html");
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain("US RECESSION CHANCE");
    expect(html).toContain("<html");
    expect(html).toContain('rel="alternate"');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('property="og:image"');
    expect(html).toContain("application/ld+json");
    expect(html).toContain("sig-table");
    expect(html).toContain("<title>US Recession Chance — 12-month US recession risk: LOW</title>");
    // feed links resolve correctly from the /ru/ subpage (audit F3)
    const ruHtml = readFileSync(join(out, "ru", "index.html"), "utf8");
    expect(ruHtml).toContain("../feed-ru.xml");
    expect(ruHtml).toContain('hreflang="en"');
    // lang toggle must stay inside the project subpath (not bare "/ru/")
    expect(html).toContain('href="https://example.test/site/ru/"');
    expect(ruHtml).toContain('href="https://example.test/site/"');
    // feeds are well-formed XML with required author element (audit F10)
    const feed = readFileSync(join(out, "feed-en.xml"), "utf8");
    expect(feed).toContain("<feed");
    expect(feed).toContain("<author>");
    expect(feed).toContain("US Recession Chance");
    expect(readdirSync(join(out, "ru"))).toContain("index.html");
    // methodology + audit pages
    const method = readFileSync(join(out, "method", "index.html"), "utf8");
    expect(method).toContain("fred.stlouisfed.org/series/");
    expect(method).toContain("Yield curve");
    const auditIdx = readFileSync(join(out, "audit", "index.html"), "utf8");
    expect(auditIdx).toContain("AUDIT week 40");
    const auditWeek = readFileSync(join(out, "audit", "2026-W40", "index.html"), "utf8");
    expect(auditWeek).toContain("score verdict");
    // Mini App sources are copied into site/app/ (PLAN2 §14)
    expect(written).toContain("app/index.html");
    const appFiles = readdirSync(join(out, "app"));
    expect(appFiles).toContain("app.js");
    expect(appFiles).toContain("styles.css");
    expect(readdirSync(join(out, "app", "vendor"))).toContain("telegram-web-app.js");
  });
});
