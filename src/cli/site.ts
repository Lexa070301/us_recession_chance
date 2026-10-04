import "dotenv/config";
import { renderSite } from "../site/render.js";

/** npm run site -- [outDir] — renders the GitHub Pages bundle (default ./site). */
const outDir = process.argv[2] ?? "site";
const written = renderSite(outDir);
console.log(`[site] wrote ${written.length} files to ${outDir}/`);
for (const f of written) console.log(`  ${f}`);
