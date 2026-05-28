import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys stats command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/statsCommand.ts"),
    "utf-8",
  );

  it("wires stats to runStatsCommand via dynamic import", () => {
    expect(cli).toContain('.command("stats")');
    expect(cli).toContain("--json");
    expect(cli).toContain("--by-project");
    expect(cli).toContain("--all");
    expect(cli).toContain(
      'const { runStatsCommand } = await import("./lib/statsCommand.js")',
    );
    expect(cli).toContain("await runStatsCommand(opts)");
  });

  it("exports runStatsCommand with stats markers", () => {
    expect(handler).toContain("export async function runStatsCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("isAvailable()");
    expect(handler).toContain("Central DB not available. Run 'gnosys init' first.");
    expect(handler).toContain("opts.byProject");
    expect(handler).toContain("getAllProjects()");
    expect(handler).toContain("getAllMemories()");
    expect(handler).toContain('name: "(user)"');
    expect(handler).toContain('name: "(global)"');
    expect(handler).toContain("rows.sort((a, b) => b.active - a.active)");
    expect(handler).toContain("PROJECT");
    expect(handler).toContain("TOTAL");
    expect(handler).toContain("findProjectIdentity(process.cwd())");
    expect(handler).toContain("opts.all");
    expect(handler).toContain("getActiveMemories()");
    expect(handler).toContain('m.scope === "user"');
    expect(handler).toContain('m.scope === "global"');
    expect(handler).toContain("No memories found.");
    expect(handler).toContain("JSON.parse(m.tags");
    expect(handler).toContain("computeStats(allMemories)");
    expect(handler).toContain("Gnosys Store Statistics:");
    expect(handler).toContain("By category:");
    expect(handler).toContain("By status:");
    expect(handler).toContain("By author:");
    expect(handler).toContain("outputResult(!!opts.json");
    expect(handler).toContain("Error:");
    expect(handler).toContain("centralDb?.close()");
  });
});
