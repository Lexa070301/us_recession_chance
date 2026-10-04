import { describe, it, expect } from "vitest";
import { cardTree } from "../src/card/layout.js";
import { collectCardData, type CardData } from "../src/card/data.js";
import { renderCard } from "../src/card/render.js";
import { createTestDb } from "../src/data/db.js";

process.env.FRED_API_KEY ??= "test-key";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const stub: CardData = {
  locale: "en",
  date: "2026-01-15",
  bucket: "elevated",
  bucketLabel: "ELEVATED",
  score: "5.5",
  modelProbLabel: "Model: 28%",
  trend: [1, 2, 2.5, 3, 4, 4.5, 5, 5.5],
  active: [
    { state: "warning", name: "Yield curve", value: "−0.42 pp" },
    { state: "watch", name: "Sahm rule", value: "0.35" },
  ],
  nowcast: "Nowcast: calm",
  handle: "@testbot",
  caption: "📊 Recession risk: ELEVATED · score 5.5",
};

describe("card layout", () => {
  it("produces a 1200x630 div tree with verdict text", () => {
    const root = cardTree(stub);
    expect(root.type).toBe("div");
    expect(root.props.style?.width).toBe(1200);
    expect(root.props.style?.height).toBe(630);
    const json = JSON.stringify(root);
    expect(json).toContain("ELEVATED");
    expect(json).toContain("score 5.5");
    expect(json).toContain("Yield curve");
  });

  it("handles empty trend and empty active list", () => {
    const root = cardTree({ ...stub, trend: [], active: [] });
    expect(root.type).toBe("div");
    expect(JSON.stringify(root)).not.toContain("NaN");
  });
});

describe("renderCard", () => {
  it("renders a valid PNG", async () => {
    const png = await renderCard(stub);
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(png.length).toBeGreaterThan(20_000);
  }, 30_000);

  it("renders cyrillic text without crashing", async () => {
    const ru: CardData = { ...stub, locale: "ru", bucketLabel: "ПОВЫШЕННЫЙ", nowcast: "Ноукаст: спокойно" };
    const png = await renderCard(ru);
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
  }, 30_000);
});

describe("collectCardData", () => {
  it("builds card data from an empty db (all-OK composite)", () => {
    const db = createTestDb();
    const d = collectCardData("en", db);
    expect(d.bucket).toBe("low");
    expect(d.active).toHaveLength(0);
    expect(d.caption).toContain("score");
  });
});
