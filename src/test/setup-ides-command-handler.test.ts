import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup ides command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("wires setup ides to interactive and --all IDE setup handlers", () => {
    expect(cli).toContain('.command("ides")');
    expect(cli).toContain('.option("--all", "Configure MCP for all supported IDEs (non-interactive)")');
    expect(cli).toContain('const { runIdesSetupAll } = await import("./lib/setup/sections/ides.js")');
    expect(cli).toContain('const { runIdesSetup } = await import("./lib/setup/sections/ides.js")');
    expect(cli).toContain("await runIdesSetup({ rl, directory: process.cwd() })");
    expect(cli).toContain("rl.close()");
  });
});
