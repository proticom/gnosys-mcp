import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys stale command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/staleCommand.ts"),
    "utf-8",
  );

  it("wires stale to runStaleCommand via dynamic import", () => {
    expect(cli).toContain('.command("stale")');
    expect(cli).toContain("-d, --days <number>");
    expect(cli).toContain("-n, --limit <number>");
    expect(cli).toContain(
      'const { runStaleCommand } = await import("./lib/staleCommand.js")',
    );
    expect(cli).toContain("await runStaleCommand(getResolver, opts)");
  });

  it("exports runStaleCommand with stale markers", () => {
    expect(handler).toContain("export async function runStaleCommand");
    expect(handler).toContain("getResolver()");
    expect(handler).toContain("parseInt(opts.days");
    expect(handler).toContain("cutoff.toISOString().split");
    expect(handler).toContain("resolver.getAllMemories()");
    expect(handler).toContain("last_reviewed");
    expect(handler).toContain("m.frontmatter.modified");
    expect(handler).toContain("localeCompare");
    expect(handler).toContain("slice(0, parseInt(opts.limit");
    expect(handler).toContain("No memories older than");
    expect(handler).toContain("memories not touched");
  });
});
