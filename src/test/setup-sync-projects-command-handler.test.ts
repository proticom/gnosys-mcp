import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup sync-projects command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/setupSyncProjectsCommand.ts"),
    "utf-8",
  );

  it("wires setup sync-projects to runSetupSyncProjectsCommand via dynamic import", () => {
    expect(cli).toContain('.command("sync-projects")');
    expect(cli).toContain("--skip-dashboard");
    expect(cli).toContain(
      'const { runSetupSyncProjectsCommand } = await import("./lib/setupSyncProjectsCommand.js")',
    );
    expect(cli).toContain("await runSetupSyncProjectsCommand(opts)");
  });

  it("exports runSetupSyncProjectsCommand with sync-projects operational markers", () => {
    expect(handler).toContain("export async function runSetupSyncProjectsCommand");
    expect(handler).toContain("projects.json");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("centralDb.getAllProjects()");
    expect(handler).toContain("createProjectIdentity(projectDir");
    expect(handler).toContain("tempResolver.registerProject(projectDir)");
    expect(handler).toContain('syncToTarget(centralDb, projectDir, "all", projectId)');
    expect(handler).toContain("cleanupRegistry({ interactive: true })");
    expect(handler).toContain("generatePortfolio(centralDb)");
    expect(handler).toContain("formatPortfolioMarkdown(report)");
    expect(handler).toContain("generatePortfolioHtml(report, dashboardPath)");
    expect(handler).not.toContain('await import("./lib/');
  });
});
