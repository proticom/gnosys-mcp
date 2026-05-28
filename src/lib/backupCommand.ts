import { copyFileSync, existsSync } from "fs";
import path from "path";
import { GnosysDB } from "./db.js";

export type BackupCommandOptions = {
  output?: string;
  to?: string;
  json?: boolean;
};

export async function runBackupCommand(opts: BackupCommandOptions): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available (better-sqlite3 missing).");
      process.exitCode = 1;
      return;
    }

    const outputDir = opts.to || opts.output;
    const backupPath = await centralDb.backup(outputDir);
    const counts = centralDb.getMemoryCount();
    const projectCount = centralDb.getAllProjects().length;

    const centralDir = GnosysDB.getCentralDbDir();
    const copiedFiles: string[] = [backupPath];
    const backupDir = path.dirname(backupPath);
    const sandboxLog = path.join(centralDir, "sandbox", "sandbox.log");
    if (existsSync(sandboxLog)) {
      const logDest = path.join(backupDir, "sandbox.log.bak");
      copyFileSync(sandboxLog, logDest);
      copiedFiles.push(logDest);
    }

    if (opts.json) {
      console.log(JSON.stringify({
        ok: true, backupPath, memories: counts.total,
        active: counts.active, archived: counts.archived,
        projects: projectCount, files: copiedFiles,
      }));
    } else {
      console.log(`Backup created: ${backupPath}`);
      console.log(`  Memories: ${counts.total} (${counts.active} active, ${counts.archived} archived)`);
      console.log(`  Projects: ${projectCount}`);
      if (copiedFiles.length > 1) console.log(`  Additional files: ${copiedFiles.length - 1}`);
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Backup failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}
