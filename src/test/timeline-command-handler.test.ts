import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys timeline command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/timelineCommand.ts"),
    "utf-8",
  );

  it("wires timeline to runTimelineCommand via dynamic import", () => {
    expect(cli).toContain('.command("timeline")');
    expect(cli).toContain("-p, --period <period>");
    expect(cli).toContain("--project <id>");
    expect(cli).toContain("--limit-titles <n>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runTimelineCommand } = await import("./lib/timelineCommand.js")',
    );
    expect(cli).toContain("await runTimelineCommand(opts)");
  });

  it("exports runTimelineCommand with timeline markers", () => {
    expect(handler).toContain("export async function runTimelineCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("isAvailable()");
    expect(handler).toContain("Central DB unavailable.");
    expect(handler).toContain("getMemoriesByProject(opts.project)");
    expect(handler).toContain("getActiveMemories()");
    expect(handler).toContain("No memories found.");
    expect(handler).toContain("groupDbByPeriod");
    expect(handler).toContain("parseInt(opts.limitTitles, 10) || 5");
    expect(handler).toContain("period");
    expect(handler).toContain("count");
    expect(handler).toContain("entries");
    expect(handler).toContain("Knowledge Timeline");
    expect(handler).toContain("created");
    expect(handler).toContain("modified");
    expect(handler).toContain("+ ${t}");
    expect(handler).toContain("centralDb.close()");
    expect(handler).toContain("outputResult(!!opts.json");
  });
});
