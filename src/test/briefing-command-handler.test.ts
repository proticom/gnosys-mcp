import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys briefing command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/briefingCommand.ts"),
    "utf-8",
  );

  it("wires briefing to runBriefingCommand via dynamic import", () => {
    expect(cli).toContain('.command("briefing [projectNameOrId]")');
    expect(cli).toContain("--project");
    expect(cli).toContain("--all");
    expect(cli).toContain("--directory");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runBriefingCommand } = await import("./lib/briefingCommand.js")',
    );
    expect(cli).toContain("await runBriefingCommand(projectNameOrId, opts)");
  });

  it("exports runBriefingCommand with briefing markers", () => {
    expect(handler).toContain("export async function runBriefingCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("Central DB not available.");
    expect(handler).toContain("generateAllBriefings");
    expect(handler).toContain("generateBriefing");
    expect(handler).toContain("detectCurrentProject");
    expect(handler).toContain('Project not found: "');
    expect(handler).toContain("No project specified and none detected.");
    expect(handler).toContain("No projects registered.");
    expect(handler).toContain("# Briefing:");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("centralDb?.close()");
  });
});
