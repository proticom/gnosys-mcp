import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup remote pull command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/setupRemotePullCommand.ts"),
    "utf-8",
  );

  it("wires setup remote pull to runSetupRemotePullCommand via dynamic import", () => {
    expect(cli).toContain('.command("pull")');
    expect(cli).toContain("--newer-wins");
    expect(cli).toContain("--verbose");
    expect(cli).toContain(
      'const { runSetupRemotePullCommand } = await import("./lib/setupRemotePullCommand.js")',
    );
    expect(cli).toContain("await runSetupRemotePullCommand(opts)");
  });

  it("exports runSetupRemotePullCommand with pull markers", () => {
    expect(handler).toContain("export async function runSetupRemotePullCommand");
    expect(handler).toContain("GnosysDB.openLocal()");
    expect(handler).toContain("Central DB not available.");
    expect(handler).toContain("Remote not configured.");
    expect(handler).toContain("RemoteSync");
    expect(handler).toContain("withHeartbeat");
    expect(handler).toContain("createProgress");
    expect(handler).toContain('strategy: opts.newerWins ? "newer-wins" : "skip-and-flag"');
    expect(handler).toContain("Pulling from remote");
    expect(handler).toContain("Pulled:");
    expect(handler).toContain("Skipped:");
    expect(handler).toContain("Conflicts:");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("sync?.closeRemote()");
    expect(handler).toContain("centralDb?.close()");
  });
});
