import { GnosysDB } from "./db.js";
import type { RemoteSync } from "./remote.js";

export type SetupRemotePullCommandOptions = {
  newerWins?: boolean;
  verbose?: boolean;
};

export async function runSetupRemotePullCommand(
  opts: SetupRemotePullCommandOptions,
): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openLocal();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available.");
      process.exitCode = 1;
      return;
    }

    const remotePath = centralDb.getMeta("remote_path");
    if (!remotePath) {
      console.error("Remote not configured.");
      process.exitCode = 1;
      return;
    }

    const { RemoteSync: RemoteSyncCtor } = await import("./remote.js");
    const { withHeartbeat } = await import("./heartbeat.js");
    const { createProgress } = await import("./progress.js");
    const progress = createProgress(!!opts.verbose);
    let sync: RemoteSync | null = null;
    try {
      sync = new RemoteSyncCtor(centralDb, remotePath);
      const runPull = () =>
        sync!.pull({
          strategy: opts.newerWins ? "newer-wins" : "skip-and-flag",
          onProgress: progress.noop ? undefined : progress.emit.bind(progress),
        });
      const result = opts.verbose
        ? await runPull()
        : await withHeartbeat("Pulling from remote", runPull);

      const projParts =
        (result.projectsPulled || 0) > 0 ? ` | Projects pulled: ${result.projectsPulled}` : "";
      const auditParts = (result.auditPulled || 0) > 0 ? ` | Audit pulled: ${result.auditPulled}` : "";
      console.log(
        `Pulled: ${result.pulled} | Skipped: ${result.skipped} | Conflicts: ${result.conflicts.length}${projParts}${auditParts}`,
      );
      if (result.errors.length > 0) {
        console.log("\nErrors:");
        for (const e of result.errors) console.log(`  ${e}`);
      }
    } finally {
      sync?.closeRemote();
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}
