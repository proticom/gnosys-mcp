import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys discover command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/discoverCommand.ts"),
    "utf-8",
  );

  it("wires discover to runDiscoverCommand via dynamic import", () => {
    expect(cli).toContain('.command("discover <query>")');
    expect(cli).toContain("-n, --limit <number>");
    expect(cli).toContain("--federated");
    expect(cli).toContain("--scope <scope>");
    expect(cli).toContain("-d, --directory <dir>");
    expect(cli).toContain("--id-format <format>");
    expect(cli).toContain(
      'const { runDiscoverCommand } = await import("./lib/discoverCommand.js")',
    );
    expect(cli).toContain("await runDiscoverCommand(query, opts)");
  });

  it("exports runDiscoverCommand with federated and default FTS markers", () => {
    expect(handler).toContain("export async function runDiscoverCommand");
    expect(handler).toContain("federatedDiscover");
    expect(handler).toContain("detectCurrentProject");
    expect(handler).toContain('opts.scope.split(",")');
    expect(handler).toContain("centralDb.discoverFts(query");
    expect(handler).toContain("formatMemoryIdHyperlink");
    expect(handler).toContain("buildProjectNameLookup");
    expect(handler).toContain("parseIdFormat(opts.idFormat)");
    expect(handler).toContain('No memories found for "${query}"');
    expect(handler).toContain("centralDb?.close()");
    expect(handler).toContain('await import("./federated.js")');
    expect(handler).toContain('await import("./idFormat.js")');
    expect(handler).not.toContain('await import("./lib/federated.js")');
  });
});
