import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys export command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/exportCommand.ts"),
    "utf-8",
  );

  it("wires export parent, vault, and project via dynamic import", () => {
    expect(cli).toContain('process.argv.splice(3, 0, "vault")');
    expect(cli).toContain('.command("export")');
    expect(cli).toContain('.command("vault")');
    expect(cli).toContain('.command("project [projectId]")');
    expect(cli).toContain('await import("./lib/exportCommand.js")');
    expect(cli).toContain("runExportUsageCommand");
    expect(cli).toContain("runVaultExportCommand");
    expect(cli).toContain("runProjectExportCommand");
  });

  it("exports export handlers with cleanup-safe markers", () => {
    expect(handler).toContain("export function runExportUsageCommand");
    expect(handler).toContain("export async function runVaultExportCommand");
    expect(handler).toContain("export async function runProjectExportCommand");
    expect(handler).toContain("new GnosysResolver()");
    expect(handler).toContain("GnosysExporter");
    expect(handler).toContain("exportProject");
    expect(handler).toContain("activeOnly: !opts.all");
    expect(handler).toContain("includeArchived: !!opts.includeArchived");
    expect(handler).toContain("includeAudit: opts.audit !== false");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).toContain("finally");
    expect(handler).toContain(".close()");
  });
});
