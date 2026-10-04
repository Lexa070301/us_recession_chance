import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/** Flatten nested yaml to dot-path keys. */
function flatKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flatKeys(v as Record<string, unknown>, key));
    else out.push(key);
  }
  return out;
}

const dir = join(__dirname, "..", "config", "locales");
const locales = new Map<string, Set<string>>();
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".yaml")) continue;
  locales.set(
    f.replace(/\.yaml$/, ""),
    new Set(flatKeys(YAML.parse(readFileSync(join(dir, f), "utf8")))),
  );
}

describe("locale files", () => {
  it("all locales expose the same key set (no orphan keys)", () => {
    const [en, ru] = [locales.get("en"), locales.get("ru")];
    expect(en).toBeDefined();
    expect(ru).toBeDefined();
    // i18next plural forms legitimately differ per locale (en: _one/_other,
    // ru: _one/_few/_many) — compare base keys with plural suffixes stripped.
    const stripPlural = (k: string) => k.replace(/_(one|other|few|many|zero|two)$/, "");
    const enBase = new Set([...en!].map(stripPlural));
    const ruBase = new Set([...ru!].map(stripPlural));
    const missingInRu = [...enBase].filter((k) => !ruBase.has(k));
    const missingInEn = [...ruBase].filter((k) => !enBase.has(k));
    expect(missingInRu, `missing in ru: ${missingInRu.join(", ")}`).toEqual([]);
    expect(missingInEn, `missing in en: ${missingInEn.join(", ")}`).toEqual([]);
  });
});
