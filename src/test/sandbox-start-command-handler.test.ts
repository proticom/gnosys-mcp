import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys sandbox start command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/sandboxStartCommand.ts"),
    "utf-8",
  );

  it("wires sandbox start to runSandboxStartCommand via dynamic import", () => {
    expect(cli).toContain('.command("sandbox")');
    expect(cli).toContain('.command("start")');
    expect(cli).toContain("--persistent");
    expect(cli).toContain("--db-path <path>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runSandboxStartCommand } = await import("./lib/sandboxStartCommand.js")',
    );
    expect(cli).toContain("await runSandboxStartCommand(opts)");
  });

  it("exports runSandboxStartCommand with sandbox start markers", () => {
    expect(handler).toContain("export async function runSandboxStartCommand");
    expect(handler).toContain("startSandbox");
    expect(handler).toContain("persistent: opts.persistent");
    expect(handler).toContain("dbPath: opts.dbPath");
    expect(handler).toContain("wait: true");
    expect(handler).toContain("JSON.stringify({ ok: true, pid })");
    expect(handler).toContain("Gnosys sandbox running (pid:");
    expect(handler).toContain("JSON.stringify({ ok: false");
    expect(handler).toContain("Failed to start sandbox:");
    expect(handler).toContain("process.exit(1)");
  });
});
