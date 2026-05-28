import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys sandbox stop command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/sandboxStopCommand.ts"),
    "utf-8",
  );

  it("wires sandbox stop to runSandboxStopCommand via dynamic import", () => {
    expect(cli).toContain('.command("sandbox")');
    expect(cli).toContain('.command("stop")');
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runSandboxStopCommand } = await import("./lib/sandboxStopCommand.js")',
    );
    expect(cli).toContain("await runSandboxStopCommand(opts)");
  });

  it("exports runSandboxStopCommand with sandbox stop markers", () => {
    expect(handler).toContain("export async function runSandboxStopCommand");
    expect(handler).toContain("stopSandbox");
    expect(handler).toContain("const wasRunning = await stopSandbox()");
    expect(handler).toContain("JSON.stringify({ ok: true, wasRunning })");
    expect(handler).toContain("Sandbox stopped.");
    expect(handler).toContain("Sandbox was not running.");
    expect(handler).toContain("JSON.stringify({ ok: false");
    expect(handler).toContain("Failed to stop sandbox:");
    expect(handler).toContain("process.exit(1)");
  });
});
