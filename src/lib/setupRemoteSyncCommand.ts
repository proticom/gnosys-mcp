import { GnosysDB } from "./db.js";
import type { RemoteSync } from "./remote.js";

export type SetupRemoteSyncCommandOptions = {
  auto?: boolean;
  newerWins?: boolean;
  verbose?: boolean;
};

export async function runSetupRemoteSyncCommand(
  opts: SetupRemoteSyncCommandOptions,
): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openLocal();
    if (!centralDb.isAvailable()) {
      if (!opts.auto) console.error("Central DB not available.");
      process.exitCode = 1;
      return;
    }

    const remotePath = centralDb.getMeta("remote_path");
    if (!remotePath) {
      if (!opts.auto) console.error("Remote not configured.");
      process.exitCode = opts.auto ? 0 : 1;
      return;
    }

    const { RemoteSync: RemoteSyncCtor } = await import("./remote.js");
    const { withHeartbeat } = await import("./heartbeat.js");
    const { createProgress } = await import("./progress.js");
    const progress = createProgress(!!opts.verbose);
    let sync: RemoteSync | null = null;
    try {
      sync = new RemoteSyncCtor(centralDb, remotePath);
      const runSync = () =>
        sync!.sync({
          auto: opts.auto,
          strategy: opts.newerWins ? "newer-wins" : "skip-and-flag",
          onProgress: progress.noop ? undefined : progress.emit.bind(progress),
        });
      const result =
        opts.auto || opts.verbose
          ? await runSync()
          : await withHeartbeat("Syncing with remote", runSync);

      if (!opts.auto || result.conflicts.length > 0 || result.errors.length > 0) {
        const pp = result.projectsPushed || 0;
        const pl = result.projectsPulled || 0;
        const ap = result.auditPushed || 0;
        const al = result.auditPulled || 0;
        const projParts = pp + pl > 0 ? ` | Projects: ↑${pp}/↓${pl}` : "";
        const auditParts = ap + al > 0 ? ` | Audit: ↑${ap}/↓${al}` : "";
        console.log(
          `Pushed: ${result.pushed} | Pulled: ${result.pulled} | Conflicts: ${result.conflicts.length}${projParts}${auditParts}`,
        );
        if (result.errors.length > 0) {
          console.log("\nErrors:");
          for (const e of result.errors) console.log(`  ${e}`);
        }
        if (result.conflicts.length > 0) {
          console.log("\nConflicts need resolution (run 'gnosys setup remote status' for details).");
        }
      }
    } finally {
      sync?.closeRemote();
    }
  } catch (err) {
    if (!opts.auto) console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}
