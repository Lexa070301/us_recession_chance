import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import i18next from "i18next";
import { getConfig } from "../../config/load.js";

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "locales");

let initialized = false;

export function initI18n(): void {
  if (initialized) return;
  const cfg = getConfig().channels.defaults;
  const resources: Record<string, { translation: Record<string, unknown> }> = {};
  for (const file of readdirSync(LOCALES_DIR)) {
    if (!file.endsWith(".yaml")) continue;
    const locale = file.replace(/\.yaml$/, "");
    resources[locale] = {
      translation: YAML.parse(readFileSync(join(LOCALES_DIR, file), "utf8")) as Record<string, unknown>,
    };
  }
  void i18next.init({
    resources,
    fallbackLng: cfg.fallback_locale,
    supportedLngs: cfg.supported_locales,
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
  initialized = true;
}

export function t(locale: string, key: string, vars: Record<string, unknown> = {}): string {
  initI18n();
  return i18next.getFixedT(locale)(key, vars) as string;
}
