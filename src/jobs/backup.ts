import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig } from "../config/load.js";
import { getDb } from "../data/db.js";

/**
 * Online backup via SQLite's backup API (safe under WAL while the process
 * writes). Keeps the newest `retain` files in <db dir>/backups/.
 */
export async function jobBackup(retain = 14): Promise<string> {
  const db = getDb();
  const dbPath = getConfig().env.databasePath;
  const dir = join(dirname(dbPath), "backups");
  mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const dest = join(dir, `recession-${ts}.db`);
  await db.backup(dest);
  console.log(`[backup] wrote ${dest}`);

  const files = readdirSync(dir)
    .filter((f) => f.startsWith("recession-") && f.endsWith(".db"))
    .sort();
  while (files.length > retain) {
    const victim = files.shift()!;
    unlinkSync(join(dir, victim));
    console.log(`[backup] pruned ${victim}`);
  }
  return dest;
}
