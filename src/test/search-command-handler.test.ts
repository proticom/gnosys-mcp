import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys search command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/searchCommand.ts"),
    "utf-8",
  );

  it("wires search to runSearchCommand via dynamic import", () => {
    expect(cli).toContain('.command("search <query>")');
    expect(cli).toContain("-n, --limit <number>");
    expect(cli).toContain("--federated");
    expect(cli).toContain("--scope <scope>");
    expect(cli).toContain("-d, --directory <dir>");
    expect(cli).toContain("--id-format <format>");
    expect(cli).toContain(
      'const { runSearchCommand } = await import("./lib/searchCommand.js")',
    );
    expect(cli).toContain("await runSearchCommand(query, opts)");
  });

  it("exports runSearchCommand with federated and default FTS markers", () => {
    expect(handler).toContain("export async function runSearchCommand");
    expect(handler).toContain("federatedSearch");
    expect(handler).toContain("detectCurrentProject");
    expect(handler).toContain('opts.scope.split(",")');
    expect(handler).toContain("centralDb.searchFts(query");
    expect(handler).toContain("boosts.join");
    expect(handler).toContain('snippet.replace(/>>>/g, "")');
    expect(handler).toContain("formatMemoryIdHyperlink");
    expect(handler).toContain("buildProjectNameLookup");
    expect(handler).toContain("parseIdFormat(opts.idFormat)");
    expect(handler).toContain('No results for "${query}"');
    expect(handler).toContain("centralDb?.close()");
    expect(handler).toContain('await import("./federated.js")');
    expect(handler).toContain('await import("./idFormat.js")');
    expect(handler).not.toContain('await import("./lib/federated.js")');
  });
});
