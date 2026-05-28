import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys sandbox status command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/sandboxStatusCommand.ts"),
    "utf-8",
  );

  it("wires sandbox status to runSandboxStatusCommand via dynamic import", () => {
    expect(cli).toContain('.command("sandbox")');
    expect(cli).toContain('.command("status")');
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runSandboxStatusCommand } = await import("./lib/sandboxStatusCommand.js")',
    );
    expect(cli).toContain("await runSandboxStatusCommand(opts)");
  });

  it("exports runSandboxStatusCommand with sandbox status markers", () => {
    expect(handler).toContain("export async function runSandboxStatusCommand");
    expect(handler).toContain("sandboxStatus");
    expect(handler).toContain("const status = await sandboxStatus()");
    expect(handler).toContain("JSON.stringify(status, null, 2)");
    expect(handler).toContain("status.running");
    expect(handler).toContain("Sandbox running (pid:");
    expect(handler).toContain("Sandbox is not running. Start with: gnosys sandbox start");
    expect(handler).toContain("JSON.stringify({ ok: false");
    expect(handler).toContain("process.exit(1)");
  });
});
