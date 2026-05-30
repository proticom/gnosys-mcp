import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys centralize command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/centralizeCommand.ts"),
    "utf-8",
  );

  it("wires centralize to runCentralizeCommand via dynamic import", () => {
    expect(cli).toContain('.command("centralize")');
    expect(cli).toContain('.requiredOption("--to <dir>"');
    expect(cli).toContain("--from-local");
    expect(cli).toContain("--force");
    expect(cli).toContain(
      'const { runCentralizeCommand } = await import("./lib/centralizeCommand.js")',
    );
    expect(cli).toContain("await runCentralizeCommand(opts)");
  });

  it("exports runCentralizeCommand with centralize markers", () => {
    expect(handler).toContain("export async function runCentralizeCommand");
    expect(handler).toContain("centralizeDb({ to: opts.to, force: opts.force })");
    expect(handler).toContain("Seeded central brain:");
    expect(handler).toContain("GNOSYS_HOME=");
    expect(handler).toContain("centralize failed:");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
  });
});
