import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("wires bare setup to runSetup and summary wizard paths", () => {
    expect(cli).toContain('.command("setup")');
    expect(cli).toContain('const { runSetup } = await import("./lib/setup.js")');
    expect(cli).toContain(
      'const { runSummaryWizard } = await import("./lib/setup/summary.js")',
    );
    expect(cli).toContain("await runSummaryWizard({ directory: projectDir })");
    expect(cli).toContain("await runSetup({");
  });
});
