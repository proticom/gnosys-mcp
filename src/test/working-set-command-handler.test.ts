import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys working-set command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/workingSetCommand.ts"),
    "utf-8",
  );

  it("wires working-set to runWorkingSetCommand via dynamic import", () => {
    expect(cli).toContain('.command("working-set")');
    expect(cli).toContain("-d, --directory <dir>");
    expect(cli).toContain("-w, --window <hours>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runWorkingSetCommand } = await import("./lib/workingSetCommand.js")',
    );
    expect(cli).toContain("await runWorkingSetCommand(opts)");
  });

  it("exports runWorkingSetCommand with working-set markers", () => {
    expect(handler).toContain("export async function runWorkingSetCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("isAvailable()");
    expect(handler).toContain("detectCurrentProject");
    expect(handler).toContain("getWorkingSet");
    expect(handler).toContain("formatWorkingSet");
    expect(handler).toContain("parseInt(opts.window, 10)");
    expect(handler).toContain("projectId: pid");
    expect(handler).toContain("windowHours");
    expect(handler).toContain("centralDb?.close()");
    expect(handler).toContain('await import("./federated.js")');
    expect(handler).not.toContain('await import("./lib/federated.js")');
  });
});
