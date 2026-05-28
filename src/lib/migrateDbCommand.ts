import path from "path";
import { GnosysDB } from "./db.js";
import { createProjectIdentity } from "./projectIdentity.js";
import type { GnosysResolver } from "./resolver.js";

export type MigrateDbCommandOptions = {
  toCentral?: boolean;
  verbose?: boolean;
};

export type MigrateDbCommandContext = {
  getResolver: () => Promise<GnosysResolver>;
};

export async function runMigrateDbCommand(
  opts: MigrateDbCommandOptions,
  context: MigrateDbCommandContext,
): Promise<void> {
  if (!opts.toCentral) {
    const resolver = await context.getResolver();
    const writeTarget = resolver.getWriteTarget();
    if (!writeTarget) {
      console.error("No writable store found. Run 'gnosys init' first.");
      process.exitCode = 1;
      return;
    }
    const { migrate, formatMigrationReport } = await import("./migrate.js");
    const stats = await migrate(writeTarget.store.getStorePath(), { verbose: opts.verbose });
    console.log(formatMigrationReport(stats));
    return;
  }

  console.log("Migrating per-project stores to central DB (~/.gnosys/gnosys.db)...\n");

  let centralDb: GnosysDB | null = null;
  try {
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      console.error(`Cannot open central DB: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return;
    }

    const resolver = await context.getResolver();
    const detectedStores = await resolver.detectAllStores();
    const projectDirs = detectedStores
      .filter(s => s.hasGnosys)
      .map(s => s.path);

    if (projectDirs.length === 0) {
      console.log("No per-project stores found to migrate.");
      return;
    }

    console.log(`Found ${projectDirs.length} project store(s) to migrate:\n`);

    let totalMemories = 0;
    let totalProjects = 0;

    for (const projectDir of projectDirs) {
      const storePath = path.join(projectDir, ".gnosys");
      const log = opts.verbose ? console.log : () => {};

      let projectDb: GnosysDB | null = null;
      try {
        const identity = await createProjectIdentity(projectDir, {
          centralDb: centralDb!,
        });

        log(`  [${identity.projectName}] ID: ${identity.projectId}`);

        projectDb = new GnosysDB(storePath);
        if (!projectDb.isAvailable() || !projectDb.isMigrated()) {
          log(`  [${identity.projectName}] No migrated gnosys.db — skipping`);
          continue;
        }

        const memories = projectDb.getAllMemories();
        let count = 0;
        centralDb!.transaction(() => {
          for (const mem of memories) {
            centralDb!.insertMemory({
              ...mem,
              project_id: identity.projectId,
              scope: "project",
            });
            count++;
          }
        });

        totalMemories += count;
        totalProjects++;
        console.log(`  ✓ ${identity.projectName}: ${count} memories migrated`);
      } catch (err) {
        console.error(`  ✗ ${projectDir}: ${err instanceof Error ? err.message : err}`);
      } finally {
        projectDb?.close();
      }
    }

    console.log(`\n╔════════════════════════════════════════╗`);
    console.log(`║  Central Migration Complete            ║`);
    console.log(`╚════════════════════════════════════════╝`);
    console.log(`  Projects migrated: ${totalProjects}`);
    console.log(`  Memories imported:  ${totalMemories}`);
    console.log(`\n  Per-project gnosys.db files are untouched.`);
    console.log(`  Central DB: ${GnosysDB.getCentralDbPath()}`);
  } finally {
    centralDb?.close();
  }
}
