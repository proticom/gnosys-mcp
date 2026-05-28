import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys stores command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("wires stores to runStoresCommand via dynamic import", () => {
    expect(cli).toContain('.command("stores")');
    expect(cli).toContain(
      '.description("Show all active stores, their layers, paths, and permissions")',
    );
    expect(cli).toContain('const { runStoresCommand } = await import("./lib/storesCommand.js")');
    expect(cli).toContain("await runStoresCommand(getResolver)");
  });
});
