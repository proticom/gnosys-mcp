import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup remote resolve command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/setupRemoteResolveCommand.ts"),
    "utf-8",
  );

  it("wires setup remote resolve to runSetupRemoteResolveCommand via dynamic import", () => {
    expect(cli).toContain('.command("resolve <memoryId>")');
    expect(cli).toContain("--keep");
    expect(cli).toContain(
      'const { runSetupRemoteResolveCommand } = await import("./lib/setupRemoteResolveCommand.js")',
    );
    expect(cli).toContain("await runSetupRemoteResolveCommand(memoryId, opts)");
  });

  it("exports runSetupRemoteResolveCommand with resolve markers", () => {
    expect(handler).toContain("export async function runSetupRemoteResolveCommand");
    expect(handler).toContain("GnosysDB.openLocal()");
    expect(handler).toContain("Central DB not available.");
    expect(handler).toContain("Remote not configured.");
    expect(handler).toContain("--keep must be");
    expect(handler).toContain("RemoteSync");
    expect(handler).toContain("resolve(memoryId");
    expect(handler).toContain("Resolved ${memoryId}: kept");
    expect(handler).toContain("Failed to resolve:");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("sync?.closeRemote()");
    expect(handler).toContain("centralDb?.close()");
  });
});
