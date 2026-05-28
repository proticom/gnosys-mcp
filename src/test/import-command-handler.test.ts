import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys import command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/importCommand.ts"),
    "utf-8",
  );

  it("wires parent import to runImportCommand via dynamic import", () => {
    expect(cli).toContain('.command("import [fileOrUrl]")');
    expect(cli).toContain("--format <format>");
    expect(cli).toContain("--mapping <json>");
    expect(cli).toContain("--dry-run");
    expect(cli).toContain(
      'const { runImportCommand } = await import("./lib/importCommand.js")',
    );
    expect(cli).toContain("await runImportCommand(getResolver, fileOrUrl, opts)");
    expect(cli).toContain('.command("project <bundlePath>")');
  });

  it("exports runImportCommand with validation and import markers", () => {
    expect(handler).toContain("export async function runImportCommand");
    expect(handler).toContain("if (!fileOrUrl)");
    expect(handler).toContain(
      "Error: --format and --mapping are required for bulk imports.",
    );
    expect(handler).toContain("JSON.parse(opts.mapping)");
    expect(handler).toContain("Error: --mapping must be valid JSON");
    expect(handler).toContain("GnosysIngestion");
    expect(handler).toContain("performImport");
    expect(handler).toContain("formatImportSummary");
    expect(handler).toContain("GnosysSearch");
    expect(handler).toContain('await import("./ingest.js")');
    expect(handler).toContain('await import("./import.js")');
    expect(handler).not.toContain('await import("./lib/ingest.js")');
  });
});
