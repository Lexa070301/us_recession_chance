import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb } from "../src/data/db.js";
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

  it("renderSite writes html, feeds and data.json for each locale", () => {
    const db = createTestDb();
    const out = mkdtempSync(join(tmpdir(), "site-"));
    const written = renderSite(out, db);
    expect(written).toContain("index.html");
    expect(written).toContain("data.json");
    expect(written).toContain("feed.en.xml");
    expect(written).toContain("ru/index.html");
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain("US RECESSION WATCH");
    expect(html).toContain("<html");
    // feeds are well-formed XML
    const feed = readFileSync(join(out, "feed.en.xml"), "utf8");
    expect(feed).toContain("<feed");
    expect(readdirSync(join(out, "ru"))).toContain("index.html");
    // Mini App sources are copied into site/app/ (PLAN2 §14)
    expect(written).toContain("app/index.html");
    const appFiles = readdirSync(join(out, "app"));
    expect(appFiles).toContain("app.js");
    expect(appFiles).toContain("styles.css");
    expect(readdirSync(join(out, "app", "vendor"))).toContain("telegram-web-app.js");
  });
});
