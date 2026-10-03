import "dotenv/config";
import { getDb } from "./data/db.js";

/**
 * Entry point. MODE env or argv[2]:
 *   bot       — grammY long polling only
 *   scheduler — cron jobs only
 *   all       — both (default for single-process deploys)
 */
const mode = (process.argv[2] ?? process.env.MODE ?? "all").toLowerCase();

async function main() {
  getDb(); // migrations

  if (mode === "bot" || mode === "all") {
    const { createBot } = await import("./bot/index.js");
    const bot = createBot();
    bot.start({
      onStart: (info) => console.log(`Bot @${info.username} started`),
    });
  }

  if (mode === "scheduler" || mode === "all") {
    const { startScheduler } = await import("./jobs/scheduler.js");
    startScheduler();
  }

  if (mode !== "bot" && mode !== "scheduler" && mode !== "all") {
    console.error(`Unknown mode: ${mode} (expected bot|scheduler|all)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
