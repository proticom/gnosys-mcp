import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys helper parent command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("declares helper as a parent container with generate subcommand handler", () => {
    expect(cli).toContain('const helperCmd = program');
    expect(cli).toContain('.command("helper")');
    expect(cli).toContain(
      "Generate a tiny TypeScript helper library that agents import to talk to the gnosys sandbox directly",
    );

    expect(cli).toContain('.command("generate")');
    expect(cli).toContain(
      'const { runHelperGenerateCommand } = await import("./lib/helperGenerateCommand.js")',
    );
    expect(cli).toContain("await runHelperGenerateCommand(opts)");
  });

  it("has no parent action between helper declaration and generate subcommand", () => {
    const helperStart = cli.indexOf('const helperCmd = program');
    const firstLeaf = cli.indexOf('helperCmd\n  .command("generate")', helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(firstLeaf).toBeGreaterThan(helperStart);

    const parentBlock = cli.slice(helperStart, firstLeaf);
    expect(parentBlock).not.toContain(".action(");
  });
});
