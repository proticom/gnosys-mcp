import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys projects command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/projectsCommand.ts"),
    "utf-8",
  );

  it("wires projects to runProjectsCommand via dynamic import", () => {
    expect(cli).toContain('.command("projects")');
    expect(cli).toContain("--json");
    expect(cli).toContain("--all");
    expect(cli).toContain("--prune");
    expect(cli).toContain("--dry-run");
    expect(cli).toContain("--yes");
    expect(cli).toContain(
      'const { runProjectsCommand } = await import("./lib/projectsCommand.js")',
    );
    expect(cli).toContain("await runProjectsCommand(opts)");
  });

  it("exports runProjectsCommand with projects markers", () => {
    expect(handler).toContain("export async function runProjectsCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("Central DB not available (better-sqlite3 missing).");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("centralDb.getAllProjects()");
    expect(handler).toContain("readMachineConfig()");
    expect(handler).toContain("effectiveProjectPath");
    expect(handler).toContain("opts.prune");
    expect(handler).toContain("opts.dryRun");
    expect(handler).toContain("opts.yes");
    expect(handler).toContain("readline/promises");
    expect(handler).toContain("try");
    expect(handler).toContain("finally");
    expect(handler).toContain("rl.close()");
    expect(handler).toContain("centralDb.deleteProject");
    expect(handler).toContain("centralDb?.close()");
  });
});
