import path from "path";
import { GnosysDB } from "./db.js";

export type RestoreCommandOptions = {
  from?: string;
  json?: boolean;
};

export async function runRestoreCommand(
  backupFile: string,
  opts: RestoreCommandOptions,
): Promise<void> {
  const resolved = path.resolve(opts.from || backupFile);
  let db: GnosysDB | null = null;
  try {
    db = GnosysDB.restore(resolved);
    const counts = db.getMemoryCount();
    const projectCount = db.getAllProjects().length;

    if (opts.json) {
      console.log(JSON.stringify({
        ok: true, source: resolved, memories: counts.total,
        active: counts.active, archived: counts.archived, projects: projectCount,
      }));
    } else {
      console.log(`Database restored from ${resolved}`);
      console.log(`  Memories: ${counts.total} (${counts.active} active, ${counts.archived} archived)`);
      console.log(`  Projects: ${projectCount}`);
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exitCode = 1;
    return;
  } finally {
    db?.close();
  }
}
