import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys bootstrap command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/bootstrapCommand.ts"),
    "utf-8",
  );

  it("wires bootstrap to runBootstrapCommand via dynamic import", () => {
    expect(cli).toContain('.command("bootstrap <sourceDir>")');
    expect(cli).toContain("-p, --pattern <patterns...>");
    expect(cli).toContain("--skip-existing");
    expect(cli).toContain("--preserve-frontmatter");
    expect(cli).toContain("--dry-run");
    expect(cli).toContain(
      'const { runBootstrapCommand } = await import("./lib/bootstrapCommand.js")',
    );
    expect(cli).toContain(
      "await runBootstrapCommand(getResolver, sourceDir, opts)",
    );
  });

  it("exports runBootstrapCommand with discoverFiles and bootstrap markers", () => {
    expect(handler).toContain("export async function runBootstrapCommand");
    expect(handler).toContain("discoverFiles(sourceDir, opts.pattern)");
    expect(handler).toContain("Nothing to import.");
    expect(handler).toContain("bootstrap(writeTarget.store");
    expect(handler).toContain('await import("./bootstrap.js")');
    expect(handler).not.toContain('await import("./lib/bootstrap.js")');
    expect(handler).toContain("Bootstrap ${mode}:");
    expect(handler).toContain("Skipped (already exist):");
    expect(handler).toContain("Failed:");
  });
});
