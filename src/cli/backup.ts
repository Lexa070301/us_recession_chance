import "dotenv/config";
import { jobBackup } from "../jobs/backup.js";

// Usage: tsx src/cli/backup.ts
jobBackup().then((p) => console.log(`Backup complete: ${p}`));
