import path from "path";
import type { GnosysDB } from "./db.js";

const validStrategies = ["merge", "replace", "new-id"] as const;
type ImportStrategy = (typeof validStrategies)[number];

export type ImportProjectCommandOptions = {
  strategy: string;
  workingDirectory?: string;
  json?: boolean;
};

export async function runImportProjectCommand(
  bundlePath: string,
  opts: ImportProjectCommandOptions,
): Promise<void> {
  if (!validStrategies.includes(opts.strategy as ImportStrategy)) {
    console.error(
      `Invalid strategy: ${opts.strategy}. Use one of: ${validStrategies.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  let centralDb: GnosysDB | null = null;
  try {
    const { GnosysDB: DbClass } = await import("./db.js");
    const { importProject } = await import("./importProject.js");

    centralDb = DbClass.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB unavailable.");
      process.exitCode = 1;
      return;
    }

    const result = importProject(centralDb, {
      bundlePath: path.resolve(bundlePath),
      strategy: opts.strategy as ImportStrategy,
      workingDirectoryOverride: opts.workingDirectory,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Imported project ${result.projectName} (${result.projectId})`);
      console.log(`  Strategy:        ${result.strategy}`);
      console.log(
        `  Memories:        ${result.memoriesInserted} inserted, ${result.memoriesSkipped} skipped, ${result.memoriesReplaced} replaced`,
      );
      console.log(`  Relationships:   ${result.relationshipsInserted}`);
      console.log(`  Audit entries:   ${result.auditEntriesInserted}`);
    }
  } catch (err) {
    console.error(
      `Import failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}
