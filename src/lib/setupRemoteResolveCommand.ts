import { GnosysDB } from "./db.js";
import type { RemoteSync } from "./remote.js";

export type SetupRemoteResolveCommandOptions = {
  keep: string;
};

export async function runSetupRemoteResolveCommand(
  memoryId: string,
  opts: SetupRemoteResolveCommandOptions,
): Promise<void> {
  if (opts.keep !== "local" && opts.keep !== "remote") {
    console.error(`--keep must be 'local' or 'remote' (got: ${opts.keep})`);
    process.exitCode = 1;
    return;
  }

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
    let sync: RemoteSync | null = null;
    try {
      sync = new RemoteSyncCtor(centralDb, remotePath);
      const result = await sync.resolve(memoryId, opts.keep as "local" | "remote");

      if (result.ok) {
        console.log(`Resolved ${memoryId}: kept ${opts.keep} version.`);
      } else {
        console.error(`Failed to resolve: ${result.error}`);
        process.exitCode = 1;
        return;
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
