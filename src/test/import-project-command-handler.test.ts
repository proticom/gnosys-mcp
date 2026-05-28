import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys import project command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/importProjectCommand.ts"),
    "utf-8",
  );

  it("wires import project to runImportProjectCommand via dynamic import", () => {
    expect(cli).toContain('.command("project <bundlePath>")');
    expect(cli).toContain("--strategy");
    expect(cli).toContain("--working-directory");
    expect(cli).toContain(
      'const { runImportProjectCommand } = await import("./lib/importProjectCommand.js")',
    );
    expect(cli).toContain("await runImportProjectCommand(bundlePath, opts)");
  });

  it("exports runImportProjectCommand with cleanup-safe import markers", () => {
    expect(handler).toContain("export async function runImportProjectCommand");
    expect(handler).toContain("Invalid strategy:");
    expect(handler).toContain("DbClass.openCentral()");
    expect(handler).toContain("Central DB unavailable.");
    expect(handler).toContain("importProject");
    expect(handler).toContain("workingDirectoryOverride");
    expect(handler).toContain("Imported project");
    expect(handler).toContain("Import failed:");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("centralDb?.close()");
    expect((handler.match(/catch \(err\)/g) ?? []).length).toBe(1);
    expect(handler.indexOf('await import("./db.js")')).toBeLessThan(
      handler.indexOf("catch (err)"),
    );
    expect(handler.indexOf("importProject(centralDb")).toBeLessThan(
      handler.indexOf("catch (err)"),
    );
  });
});
