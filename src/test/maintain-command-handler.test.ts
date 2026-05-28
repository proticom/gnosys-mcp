import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys maintain command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/maintainCommand.ts"),
    "utf-8",
  );

  it("wires maintain to runMaintainCommand via dynamic import", () => {
    expect(cli).toContain('.command("maintain")');
    expect(cli).toContain("--dry-run");
    expect(cli).toContain("--auto-apply");
    expect(cli).toContain(
      'const { runMaintainCommand } = await import("./lib/maintainCommand.js")',
    );
    expect(cli).toContain("await runMaintainCommand(getResolver, opts)");
  });

  it("exports runMaintainCommand with maintain markers", () => {
    expect(handler).toContain("export async function runMaintainCommand");
    expect(handler).toContain("resolver.getStores()");
    expect(handler).toContain("No Gnosys stores found. Run gnosys init first.");
    expect(handler).toContain("loadConfig(stores[0].path)");
    expect(handler).toContain("new GnosysMaintenanceEngine(resolver, cfg)");
    expect(handler).toContain("dryRun: opts.dryRun");
    expect(handler).toContain("autoApply: opts.autoApply");
    expect(handler).toContain('level === "warn"');
    expect(handler).toContain('level === "action"');
    expect(handler).toContain("onProgress");
    expect(handler).toContain("process.stdout.write");
    expect(handler).toContain("formatMaintenanceReport(report)");
  });
});
