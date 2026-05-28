import { GnosysDB } from "./db.js";
import type { RemoteSync } from "./remote.js";

export type SetupRemotePushCommandOptions = {
  newerWins?: boolean;
  verbose?: boolean;
};

export async function runSetupRemotePushCommand(
  opts: SetupRemotePushCommandOptions,
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
      const runPush = () =>
        sync!.push({
          strategy: opts.newerWins ? "newer-wins" : "skip-and-flag",
          onProgress: progress.noop ? undefined : progress.emit.bind(progress),
        });
      const result = opts.verbose
        ? await runPush()
        : await withHeartbeat("Pushing to remote", runPush);

      const projParts =
        (result.projectsPushed || 0) > 0 ? ` | Projects pushed: ${result.projectsPushed}` : "";
      const auditParts = (result.auditPushed || 0) > 0 ? ` | Audit pushed: ${result.auditPushed}` : "";
      console.log(
        `Pushed: ${result.pushed} | Skipped: ${result.skipped} | Conflicts: ${result.conflicts.length}${projParts}${auditParts}`,
      );
      if (result.errors.length > 0) {
        console.log("\nErrors:");
        for (const e of result.errors) console.log(`  ${e}`);
      }
      if (result.conflicts.length > 0) {
        console.log("\nConflicts flagged (run 'gnosys setup remote status' for details):");
        for (const c of result.conflicts) console.log(`  ${c.memoryId} — ${c.title}`);
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
