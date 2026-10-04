import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config/load.js";
import { getDb } from "../data/db.js";
import { collectCardData } from "../card/data.js";
import { renderCard } from "../card/render.js";
import { renderSite } from "../site/render.js";

/** npm run site -- [outDir] — renders the GitHub Pages bundle (default ./site). */
const outDir = process.argv[2] ?? "site";
const db = getDb();
const written = renderSite(outDir, db);
console.log(`[site] wrote ${written.length} files to ${outDir}/`);
for (const f of written) console.log(`  ${f}`);

// og:image — fresh card.png every deploy (independent of CARD_ENABLED:
// it's a link-preview asset, not a Telegram post). 1200×630 = og standard.
const fallback = getConfig().channels.defaults.fallback_locale;
const png = await renderCard(collectCardData(fallback, db));
writeFileSync(join(outDir, "card.png"), png);
console.log(`  card.png (og:image, ${png.length} bytes)`);
