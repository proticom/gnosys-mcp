export type SandboxStartCommandOptions = {
  persistent?: boolean;
  dbPath?: string;
  json?: boolean;
};

export async function runSandboxStartCommand(
  opts: SandboxStartCommandOptions,
): Promise<void> {
  try {
    const { startSandbox } = await import("../sandbox/manager.js");
    const pid = await startSandbox({
      persistent: opts.persistent,
      dbPath: opts.dbPath,
      wait: true,
    });

    if (opts.json) {
      console.log(JSON.stringify({ ok: true, pid }));
    } else {
      console.log(`Gnosys sandbox running (pid: ${pid})`);
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Failed to start sandbox: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}
