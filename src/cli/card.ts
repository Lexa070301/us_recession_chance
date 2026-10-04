import "dotenv/config";
import { writeFileSync } from "node:fs";
import { collectCardData } from "../card/data.js";
import { renderCard } from "../card/render.js";

/**
 * Card test stand (PLAN2 §4): renders the digest PNG to a file for manual
 * inspection — production delivery stays off until CARD_ENABLED=true.
 *
 * Usage: npm run card -- [--ru] [--out card.png]
 */

const args = process.argv.slice(2);
const locale = args.includes("--ru") ? "ru" : "en";
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : `card-${locale}.png`;

const data = collectCardData(locale);
const png = await renderCard(data);
writeFileSync(out, png);
console.log(`wrote ${out} — ${png.length} bytes`);
console.log(`bucket=${data.bucket} score=${data.score} model=${data.modelProbLabel ?? "n/a"} trend=${data.trend.length}pts active=${data.active.length}`);
