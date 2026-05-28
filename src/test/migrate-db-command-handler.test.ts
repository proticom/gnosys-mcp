import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys migrate-db command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/migrateDbCommand.ts"),
    "utf-8",
  );

  it("wires migrate-db to runMigrateDbCommand via dynamic import", () => {
    expect(cli).toContain('.command("migrate-db")');
    expect(cli).toContain("--to-central");
    expect(cli).toContain("-v, --verbose");
    expect(cli).toContain(
      'const { runMigrateDbCommand } = await import("./lib/migrateDbCommand.js")',
    );
    expect(cli).toContain("await runMigrateDbCommand(opts, { getResolver })");
  });

  it("exports runMigrateDbCommand with migrate-db markers", () => {
    expect(handler).toContain("export async function runMigrateDbCommand");
    expect(handler).toContain("context.getResolver()");
    expect(handler).toContain("migrate(writeTarget.store.getStorePath()");
    expect(handler).toContain("formatMigrationReport(stats)");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("Central DB not available (better-sqlite3 missing).");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("resolver.detectAllStores()");
    expect(handler).toContain("createProjectIdentity");
    expect(handler).toContain("centralDb!.transaction");
    expect(handler).toContain("projectDb?.close()");
    expect(handler).toContain("centralDb?.close()");
  });
});
