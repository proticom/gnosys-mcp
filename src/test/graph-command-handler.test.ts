import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys graph command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/graphCommand.ts"),
    "utf-8",
  );

  it("wires graph to runGraphCommand via dynamic import", () => {
    expect(cli).toContain('.command("graph")');
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runGraphCommand } = await import("./lib/graphCommand.js")',
    );
    expect(cli).toContain("await runGraphCommand(opts)");
  });

  it("exports runGraphCommand with graph markers", () => {
    expect(handler).toContain("export async function runGraphCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("isAvailable()");
    expect(handler).toContain("Central DB not available.");
    expect(handler).toContain("getAllMemories()");
    expect(handler).toContain("No memories found.");
    expect(handler).toContain("JSON.parse(m.tags)");
    expect(handler).toContain("buildLinkGraph(adapted)");
    expect(handler).toContain("formatGraphSummary(graph)");
    expect(handler).toContain("outputResult(!!opts.json");
    expect(handler).toContain("totalLinks");
    expect(handler).toContain("orphanedLinks");
    expect(handler).toContain("nodes");
    expect(handler).toContain("centralDb?.close()");
    expect(handler).toContain('from "./wikilinks.js"');
  });
});
