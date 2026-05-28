import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys fsearch command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/fsearchCommand.ts"),
    "utf-8",
  );

  it("wires fsearch to runFsearchCommand via dynamic import", () => {
    expect(cli).toContain('.command("fsearch <query>")');
    expect(cli).toContain("-l, --limit <n>");
    expect(cli).toContain("--no-global");
    expect(cli).toContain("--scope <scope>");
    expect(cli).toContain(
      'const { runFsearchCommand } = await import("./lib/fsearchCommand.js")',
    );
    expect(cli).toContain("await runFsearchCommand(query, opts)");
  });

  it("exports runFsearchCommand with federated and output markers", () => {
    expect(handler).toContain("export async function runFsearchCommand");
    expect(handler).toContain("federatedSearch");
    expect(handler).toContain("detectCurrentProject");
    expect(handler).toContain('opts.scope.split(",")');
    expect(handler).toContain("includeGlobal: opts.global");
    expect(handler).toContain(
      "JSON.stringify({ query, projectId, count: results.length, results }",
    );
    expect(handler).toContain("No project detected");
    expect(handler).toContain("boosts.join");
    expect(handler).toContain("centralDb?.close()");
    expect(handler).toContain('await import("./federated.js")');
    expect(handler).not.toContain('await import("./lib/federated.js")');
  });
});
