import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys helper generate command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/helperGenerateCommand.ts"),
    "utf-8",
  );

  it("wires helper generate to runHelperGenerateCommand via dynamic import", () => {
    expect(cli).toContain('.command("helper")');
    expect(cli).toContain('.command("generate")');
    expect(cli).toContain("-d, --directory <dir>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runHelperGenerateCommand } = await import("./lib/helperGenerateCommand.js")',
    );
    expect(cli).toContain("await runHelperGenerateCommand(opts)");
  });

  it("exports runHelperGenerateCommand with helper generate markers", () => {
    expect(handler).toContain("export async function runHelperGenerateCommand");
    expect(handler).toContain("generateHelper");
    expect(handler).toContain("opts.directory || process.cwd()");
    expect(handler).toContain("const outputPath = await generateHelper(targetDir)");
    expect(handler).toContain("JSON.stringify({ ok: true, path: outputPath })");
    expect(handler).toContain("Generated:");
    expect(handler).toContain("Usage in your agent/script:");
    expect(handler).toContain("JSON.stringify({ ok: false");
    expect(handler).toContain("Failed to generate helper:");
    expect(handler).toContain("process.exit(1)");
  });
});
