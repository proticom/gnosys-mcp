import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys status command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(join(process.cwd(), "src/lib/statusCommand.ts"), "utf-8");

  it("wires status to runStatusCommand via dynamic import", () => {
    expect(cli).toContain('.command("status")');
    expect(cli).toContain("--projects");
    expect(cli).toContain("--global");
    expect(cli).toContain("--remote");
    expect(cli).toContain("--system");
    expect(cli).toContain("--web");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runStatusCommand } = await import("./lib/statusCommand.js")',
    );
    expect(cli).toContain("await runStatusCommand(opts, { getResolver, loadConfig, pkgVersion: pkg.version })");
  });

  it("exports runStatusCommand with status markers", () => {
    expect(handler).toContain("export async function runStatusCommand");
    expect(handler).toContain("if (opts.projects) opts.global = true");
    expect(handler).toContain("RemoteSync");
    expect(handler).toContain("let sync: RemoteSync | null = null");
    expect(handler).toContain("sync?.closeRemote()");
    expect(handler).toContain("Resolve with: gnosys setup remote resolve <memory-id> --keep <local|remote>");
    expect(handler).toContain("collectDashboardData");
    expect(handler).toContain("dashDb = GnosysDB.openCentral()");
    expect(handler).toContain("!dashDb.isMigrated()");
    expect(handler).toContain("generatePortfolio");
    expect(handler).toContain("generatePortfolioHtml");
    expect(handler).toContain("detectCurrentProject");
    expect(handler).toContain("No project detected");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("remoteCentralDb?.close()");
    expect(handler).toContain("dashDb?.close()");
    expect(handler).toContain("centralDb?.close()");
  });
});
