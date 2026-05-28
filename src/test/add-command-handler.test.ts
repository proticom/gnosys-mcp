import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys add command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handlers = readFileSync(
    join(process.cwd(), "src/lib/addCommand.ts"),
    "utf-8",
  );

  it("wires add to runAddCommand via dynamic import", () => {
    expect(cli).toContain('.command("add <input>")');
    expect(cli).toContain(
      '.description("Add a new memory (uses LLM to structure raw input)")',
    );
    expect(cli).toContain('-a, --author <author>');
    expect(cli).toContain("--authority <authority>");
    expect(cli).toContain("-s, --store <store>");
    expect(cli).toContain(
      'const { runAddCommand } = await import("./lib/addCommand.js")',
    );
    expect(cli).toContain(
      "await runAddCommand(getResolver, input, opts, resolveProjectId)",
    );
  });

  it("exports runAddCommand with correct module imports", () => {
    expect(handlers).toContain("export async function runAddCommand");
    expect(handlers).toContain('await import("./multimodalIngest.js")');
    expect(handlers).toContain('await import("./ingest.js")');
    expect(handlers).not.toContain('await import("./lib/multimodalIngest.js")');
    expect(handlers).not.toContain('await import("./lib/ingest.js")');
  });
});
