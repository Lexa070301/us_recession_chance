import { describe, it, expect } from "vitest";
import { MENU_COMMANDS } from "../src/bot/commands.js";
import { t } from "../src/publish/render/i18n.js";

process.env.FRED_API_KEY ??= "test-key";

describe("bot command menu", () => {
  it("has en+ru descriptions within Telegram limits for every command", () => {
    for (const c of MENU_COMMANDS) {
      // Bot API: command names are 1-32 chars of a-z0-9_
      expect(c).toMatch(/^[a-z0-9_]{1,32}$/);
      for (const loc of ["en", "ru"]) {
        const d = t(loc, `bot.cmd.${c}`);
        // i18next returns the key itself on a miss — assert it actually resolved
        expect(d, `${loc}:bot.cmd.${c}`).not.toBe(`bot.cmd.${c}`);
        expect(d.length, `${loc}:bot.cmd.${c}`).toBeGreaterThan(0);
        expect(d.length, `${loc}:bot.cmd.${c}`).toBeLessThanOrEqual(256);
      }
    }
  });
});
