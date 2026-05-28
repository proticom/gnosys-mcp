import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys connect command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(join(process.cwd(), "src/lib/connectCommand.ts"), "utf-8");

  it("wires connect to runConnectCommand via dynamic import", () => {
    expect(cli).toContain('.command("connect")');
    expect(cli).toContain('.requiredOption("--url <url>"');
    expect(cli).toContain("--token <token>");
    expect(cli).toContain("--ide <ide>");
    expect(cli).toContain("--dir <dir>");
    expect(cli).toContain("--print");
    expect(cli).toContain(
      'const { runConnectCommand } = await import("./lib/connectCommand.js")',
    );
    expect(cli).toContain("await runConnectCommand(opts)");
  });

  it("exports runConnectCommand with connect markers", () => {
    expect(handler).toContain("export async function runConnectCommand");
    expect(handler).toContain("remoteMcpEntry(remote)");
    expect(handler).toContain("writeRemoteClientConfig");
    expect(handler).toContain("claude-desktop");
    expect(handler).toContain("opts.dir || process.cwd()");
    expect(handler).toContain("connect failed:");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
  });
});
