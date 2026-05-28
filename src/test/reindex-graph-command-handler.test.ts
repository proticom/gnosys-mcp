import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys reindex-graph command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/reindexGraphCommand.ts"),
    "utf-8",
  );

  it("wires reindex-graph to runReindexGraphCommand via dynamic import", () => {
    expect(cli).toContain('.command("reindex-graph")');
    expect(cli).toContain(
      'const { runReindexGraphCommand } = await import("./lib/reindexGraphCommand.js")',
    );
    expect(cli).toContain("await runReindexGraphCommand(getResolver)");
  });

  it("exports runReindexGraphCommand with reindex-graph markers", () => {
    expect(handler).toContain("export async function runReindexGraphCommand");
    expect(handler).toContain("reindexGraph");
    expect(handler).toContain("formatGraphStats");
    expect(handler).toContain("resolver.getStores()");
    expect(handler).toContain("No Gnosys stores found. Run gnosys init first.");
    expect(handler).toContain("process.exit(1)");
    expect(handler).toContain("const stats = await reindexGraph(resolver");
    expect(handler).toContain("(msg) => console.log(msg)");
    expect(handler).toContain('console.log("")');
    expect(handler).toContain("console.log(formatGraphStats(stats))");
  });
});
