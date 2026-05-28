export type SandboxStatusCommandOptions = {
  json?: boolean;
};

export async function runSandboxStatusCommand(
  opts: SandboxStatusCommandOptions,
): Promise<void> {
  try {
    const { sandboxStatus } = await import("../sandbox/manager.js");
    const status = await sandboxStatus();

    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
    } else if (status.running) {
      console.log(`Sandbox running (pid: ${status.pid}, socket: ${status.socketPath})`);
    } else {
      console.log("Sandbox is not running. Start with: gnosys sandbox start");
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}
