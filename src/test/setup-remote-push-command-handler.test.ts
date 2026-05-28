import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup remote push command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/setupRemotePushCommand.ts"),
    "utf-8",
  );

  it("wires setup remote push to runSetupRemotePushCommand via dynamic import", () => {
    expect(cli).toContain('.command("push")');
    expect(cli).toContain("--newer-wins");
    expect(cli).toContain("--verbose");
    expect(cli).toContain(
      'const { runSetupRemotePushCommand } = await import("./lib/setupRemotePushCommand.js")',
    );
    expect(cli).toContain("await runSetupRemotePushCommand(opts)");
  });

  it("exports runSetupRemotePushCommand with push markers", () => {
    expect(handler).toContain("export async function runSetupRemotePushCommand");
    expect(handler).toContain("GnosysDB.openLocal()");
    expect(handler).toContain("Central DB not available.");
    expect(handler).toContain("Remote not configured.");
    expect(handler).toContain("RemoteSync");
    expect(handler).toContain("withHeartbeat");
    expect(handler).toContain("createProgress");
    expect(handler).toContain('strategy: opts.newerWins ? "newer-wins" : "skip-and-flag"');
    expect(handler).toContain("Pushed:");
    expect(handler).toContain("Conflicts flagged (run 'gnosys setup remote status' for details):");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("sync?.closeRemote()");
    expect(handler).toContain("centralDb?.close()");
  });
});
