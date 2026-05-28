import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys restore command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/restoreCommand.ts"),
    "utf-8",
  );

  it("wires restore to runRestoreCommand via dynamic import", () => {
    expect(cli).toContain('.command("restore <backupFile>")');
    expect(cli).toContain("--from <file>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runRestoreCommand } = await import("./lib/restoreCommand.js")',
    );
    expect(cli).toContain("await runRestoreCommand(backupFile, opts)");
  });

  it("exports runRestoreCommand with restore markers", () => {
    expect(handler).toContain("export async function runRestoreCommand");
    expect(handler).toContain("path.resolve(opts.from || backupFile)");
    expect(handler).toContain("GnosysDB.restore(resolved)");
    expect(handler).toContain("db.getMemoryCount()");
    expect(handler).toContain("db.getAllProjects().length");
    expect(handler).toContain("Database restored from");
    expect(handler).toContain("Restore failed:");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("db?.close()");
  });
});
