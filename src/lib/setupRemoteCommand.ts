import { GnosysDB } from "./db.js";

export type SetupRemoteCommandOptions = {
  path?: string;
};

export async function runSetupRemoteCommand(
  opts: SetupRemoteCommandOptions,
): Promise<void> {
  let db: GnosysDB | null = null;
  try {
    db = GnosysDB.openLocal();
    if (!db.isAvailable()) {
      console.error("Central DB not available.");
      process.exitCode = 1;
      return;
    }
    if (opts.path) {
      const { configureFromPath } = await import("./remoteWizard.js");
      await configureFromPath(db, opts.path);
    } else {
      const { runConfigureWizard } = await import("./remoteWizard.js");
      await runConfigureWizard(db);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    db?.close();
  }
}
