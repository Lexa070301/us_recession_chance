import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { CardData } from "./data.js";
import { cardTree } from "./layout.js";

/**
 * Card renderer (PLAN2 §4): satori (HTML-like tree → SVG) + resvg-js
 * (SVG → PNG, WASM — no native deps, works in GHA).
 * Feature-gated by CARD_ENABLED; tested via `npm run card`.
 */

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "fonts");

type SatoriFont = { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" };

let fonts: SatoriFont[] | undefined;

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Inter 400/700 full TTF (OFL, latin + cyrillic). Google subset WOFFs
 * broke under satori's parser — full TTF instances render correctly. */
function loadFonts(): SatoriFont[] {
  if (fonts) return fonts;
  fonts = ([400, 700] as const).map((weight) => ({
    name: "Inter",
    data: toArrayBuffer(readFileSync(join(FONT_DIR, `inter-${weight}.ttf`))),
    weight,
    style: "normal" as const,
  }));
  return fonts;
}

export async function renderCard(data: CardData): Promise<Buffer> {
  const svg = await satori(cardTree(data) as never, {
    width: 1200,
    height: 630,
    fonts: loadFonts(),
  });
  const png = new Resvg(svg, { background: "#0d1524" }).render().asPng();
  return Buffer.from(png);
}
