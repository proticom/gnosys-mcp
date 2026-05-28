import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup remote sync command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/setupRemoteSyncCommand.ts"),
    "utf-8",
  );

  it("wires setup remote sync to runSetupRemoteSyncCommand via dynamic import", () => {
    expect(cli).toContain('.command("sync")');
    expect(cli).toContain("--auto");
    expect(cli).toContain("--newer-wins");
    expect(cli).toContain("--verbose");
    expect(cli).toContain(
      'const { runSetupRemoteSyncCommand } = await import("./lib/setupRemoteSyncCommand.js")',
    );
    expect(cli).toContain("await runSetupRemoteSyncCommand(opts)");
  });

  it("exports runSetupRemoteSyncCommand with sync markers", () => {
    expect(handler).toContain("export async function runSetupRemoteSyncCommand");
    expect(handler).toContain("GnosysDB.openLocal()");
    expect(handler).toContain("Central DB not available.");
    expect(handler).toContain("Remote not configured.");
    expect(handler).toContain("RemoteSync");
    expect(handler).toContain("withHeartbeat");
    expect(handler).toContain("createProgress");
    expect(handler).toContain("Syncing with remote");
    expect(handler).toContain('strategy: opts.newerWins ? "newer-wins" : "skip-and-flag"');
    expect(handler).toContain("process.exitCode = opts.auto ? 0 : 1");
    expect(handler).not.toContain("process.exit(");
    expect(handler).toContain("Conflicts need resolution (run 'gnosys setup remote status' for details).");
    expect(handler).toContain("sync?.closeRemote()");
    expect(handler).toContain("centralDb?.close()");
  });
});
