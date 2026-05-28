import path from "path";
import { GnosysDB } from "./db.js";
import { readProjectIdentity } from "./projectIdentity.js";
import { syncToTarget } from "./rulesGen.js";

export type SyncCommandOptions = {
  directory?: string;
  target?: string;
  global?: boolean;
};

export async function runSyncCommand(opts: SyncCommandOptions): Promise<void> {
  const projectDir = opts.directory ? path.resolve(opts.directory) : process.cwd();
  const target = opts.global ? "global" : (opts.target || null);

  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available (better-sqlite3 missing).");
      process.exitCode = 1;
      return;
    }

    if (target === "global") {
      const results = await syncToTarget(centralDb, projectDir, "global", null);
      for (const result of results) {
        const action = result.created ? "Created" : "Updated";
        console.log(`${action} global rules: ${result.filePath}`);
        console.log(`  Preferences injected: ${result.prefCount}`);
      }
      console.log(`\nContent is inside <!-- GNOSYS:START --> / <!-- GNOSYS:END --> markers.`);
      console.log(`User content outside these markers is preserved.`);
      return;
    }

    const identity = await readProjectIdentity(projectDir);
    if (!identity) {
      console.error("No project identity found. Run 'gnosys init' first.");
      process.exitCode = 1;
      return;
    }

    const resolvedTarget = target || identity.agentRulesTarget || "all";

    const results = await syncToTarget(
      centralDb,
      projectDir,
      resolvedTarget,
      identity.projectId,
    );

    if (results.length === 0) {
      console.error("No targets found. Create a CLAUDE.md, .cursor/, or .codex/ directory first.");
      process.exitCode = 1;
      return;
    }

    for (const result of results) {
      const action = result.created ? "Created" : "Updated";
      console.log(`${action} rules file: ${result.filePath}`);
      console.log(`  Preferences injected: ${result.prefCount}`);
      console.log(`  Project conventions:  ${result.conventionCount}`);
    }
    console.log(`\nContent is inside <!-- GNOSYS:START --> / <!-- GNOSYS:END --> markers.`);
    console.log(`User content outside these markers is preserved.`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}
