import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys machine parent command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("declares machine as a parent container with show and migrate subcommands", () => {
    expect(cli).toContain("const machineCmd = program");
    expect(cli).toContain('.command("machine")');
    expect(cli).toContain("Manage this machine's local config");
    expect(cli).toContain('.command("show")');
    expect(cli).toContain("--json");
    expect(cli).toContain('await import("./lib/machineConfig.js")');
    expect(cli).toContain('await import("./lib/paths.js")');
    expect(cli).toContain("outputResult");
    expect(cli).toContain('.command("migrate")');
    expect(cli).toContain("--root");
    expect(cli).toContain("--no-scan");
    expect(cli).toContain('await import("./lib/machineMigrate.js")');
    expect(cli).toContain("Central DB not available");
  });

  it("has no parent action between machine declaration and first leaf command", () => {
    const machineStart = cli.indexOf("const machineCmd = program");
    const firstLeaf = cli.indexOf('machineCmd\n  .command("show")', machineStart);
    expect(machineStart).toBeGreaterThan(-1);
    expect(firstLeaf).toBeGreaterThan(machineStart);
    expect(cli.slice(machineStart, firstLeaf)).not.toContain(".action(");
  });
});
