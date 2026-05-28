import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup remote parent command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/setupRemoteCommand.ts"),
    "utf-8",
  );

  it("wires bare setup remote to runSetupRemoteCommand via dynamic import", () => {
    expect(cli).toContain('setupRemoteCmd');
    expect(cli).toContain('--path <path>"');
    expect(cli).toContain(
      'const { runSetupRemoteCommand } = await import("./lib/setupRemoteCommand.js")',
    );
    expect(cli).toContain("await runSetupRemoteCommand(opts)");
  });

  it("exports runSetupRemoteCommand with setup-remote markers", () => {
    expect(handler).toContain("export async function runSetupRemoteCommand");
    expect(handler).toContain("GnosysDB.openLocal()");
    expect(handler).toContain("Central DB not available.");
    expect(handler).toContain("configureFromPath");
    expect(handler).toContain("runConfigureWizard");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).toContain("Error: ${err instanceof Error ? err.message : err}");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("db?.close()");
  });
});
