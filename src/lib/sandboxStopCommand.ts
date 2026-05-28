export type SandboxStopCommandOptions = {
  json?: boolean;
};

export async function runSandboxStopCommand(
  opts: SandboxStopCommandOptions,
): Promise<void> {
  try {
    const { stopSandbox } = await import("../sandbox/manager.js");
    const wasRunning = await stopSandbox();

    if (opts.json) {
      console.log(JSON.stringify({ ok: true, wasRunning }));
    } else {
      console.log(wasRunning ? "Sandbox stopped." : "Sandbox was not running.");
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Failed to stop sandbox: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}
