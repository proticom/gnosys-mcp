import { centralizeDb } from "./centralize.js";

export type CentralizeCommandOptions = {
  to: string;
  force?: boolean;
};

export async function runCentralizeCommand(
  opts: CentralizeCommandOptions,
): Promise<void> {
  try {
    const r = await centralizeDb({ to: opts.to, force: opts.force });
    const mb = (r.bytes / 1024 / 1024).toFixed(1);
    console.log("✓ Seeded central brain:");
    console.log(`  from: ${r.source}`);
    console.log(`  to:   ${r.target} (${mb} MB)`);
    console.log("");
    console.log(
      `Run the server against it with GNOSYS_HOME=${opts.to}, or mount this dir as the container's /data volume.`,
    );
  } catch (e) {
    console.error(`centralize failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}
