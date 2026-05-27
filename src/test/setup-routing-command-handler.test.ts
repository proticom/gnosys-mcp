import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup routing command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("wires setup routing to runRoutingSetup with readline cleanup", () => {
    expect(cli).toContain('.command("routing")');
    expect(cli).toContain('const readline = await import("readline/promises")');
    expect(cli).toContain('const { runRoutingSetup } = await import("./lib/setup/sections/routing.js")');
    expect(cli).toContain("await runRoutingSetup({ rl, directory: process.cwd() })");
    expect(cli).toContain("rl.close()");
  });
});
