import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys migrate command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/migrateCommand.ts"),
    "utf-8",
  );

  it("wires migrate to runMigrateCommand via dynamic import", () => {
    expect(cli).toContain('.command("migrate")');
    expect(cli).toContain("--from <dir>");
    expect(cli).toContain("--to <dir>");
    expect(cli).toContain("--name <name>");
    expect(cli).toContain("--yes");
    expect(cli).toContain(
      'const { runMigrateCommand } = await import("./lib/migrateCommand.js")',
    );
    expect(cli).toContain("await runMigrateCommand(opts)");
  });

  it("exports runMigrateCommand with migrate markers", () => {
    expect(handler).toContain("export async function runMigrateCommand");
    expect(handler).toContain("createInterface");
    expect(handler).toContain("opts.yes ? null");
    expect(handler).toContain("findProjectIdentity(process.cwd())");
    expect(handler).toContain("path.resolve(opts.from)");
    expect(handler).toContain("path.resolve(opts.to)");
    expect(handler).toContain("readProjectIdentity(sourceDir)");
    expect(handler).toContain('glob("**/*.md"');
    expect(handler).toContain("migrateProject({");
    expect(handler).toContain("sourcePath: sourceDir");
    expect(handler).toContain("targetPath: targetDir");
    expect(handler).toContain("deleteSource: doDelete");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("syncMemoryToDb(");
    expect(handler).toContain("centralDb?.close()");
    expect(handler).toContain("rl?.close()");
    expect(handler).toContain("finally");
    expect(handler).toContain("Migration failed:");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).toContain("return;");
    expect(handler).not.toContain("process.exit(1)");
  });
});
