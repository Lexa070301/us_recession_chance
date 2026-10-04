import { describe, it, expect } from "vitest";
import { sparkline, deltaLabel, renderWeeklyDashboard } from "../src/publish/render/templates.js";
import type { CompositeResult } from "../src/signals/score.js";

process.env.FRED_API_KEY ??= "test-key";

describe("sparkline", () => {
  it("renders one char per point", () => {
    expect(sparkline([0, 7, 14])).toHaveLength(3);
    expect(sparkline([0, 7, 14], 2)).toHaveLength(2); // width cap keeps the newest
  });
  it("handles empty and flat series", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([5, 5, 5])).toMatch(/^[▁-▇]{3}$/);
  });
});

describe("deltaLabel", () => {
  it("shows direction and magnitude", () => {
    expect(deltaLabel(6.5, 5, "en")).toContain("▲ +1.5");
    expect(deltaLabel(4, 5.5, "en")).toContain("▼ -1.5");
    expect(deltaLabel(5, null, "en")).toBe("");
  });
});

describe("renderWeeklyDashboard", () => {
  const composite: CompositeResult = {
    score: 6.5,
    bucket: "elevated",
    probLabel: "≈35–60%",
    detail: { a: { state: "warning", weight: 1, contribution: 1 } },
    modelProb: 0.4,
  };

  it("contains verdict, delta, sparkline and read-more links", () => {
    const text = renderWeeklyDashboard(
      [], [], composite, [3, 4, 5, 6.5], 5, "en", "2026-W40",
      { site: "https://site.test", telegraph: "https://telegra.ph/x" },
      "botname",
    );
    expect(text).toContain("Weekly dashboard");
    expect(text).toContain("ELEVATED");
    expect(text).toContain("▲ +1.5");
    expect(text).toMatch(/[▁-▇]/);
    expect(text).toContain("telegra.ph/x");
    expect(text).toContain("site.test");
    expect(text).toContain("@botname");
  });
});
