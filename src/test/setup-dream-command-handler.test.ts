import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup dream command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("wires setup dream to runDreamSetup with the current directory", () => {
    expect(cli).toContain('.command("dream")');
    expect(cli).toContain('const { runDreamSetup } = await import("./lib/setup.js")');
    expect(cli).toContain("await runDreamSetup({ directory: process.cwd() })");
  });
});
