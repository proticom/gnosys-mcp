import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys scan command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const projectScan = readFileSync(
    join(process.cwd(), "src/lib/projectScan.ts"),
    "utf-8",
  );

  it("wires scan to ensureMachineConfig, getMachineConfigPath, and scanProjects", () => {
    expect(cli).toContain('.command("scan")');
    expect(cli).toContain(
      "Discover projects under this machine's roots (machine.json) and record their machine-portable locations",
    );
    expect(cli).toContain("--json");
    expect(cli).toContain('await import("./lib/machineConfig.js")');
    expect(cli).toContain('await import("./lib/paths.js")');
    expect(cli).toContain('await import("./lib/projectScan.js")');
    expect(cli).toContain("ensureMachineConfig()");
    expect(cli).toContain("getMachineConfigPath()");
    expect(cli).toContain("scanProjects(db, machine)");
    expect(cli).toContain("GnosysDB.openCentral()");
    expect(cli).toContain("No project roots configured for this machine.");
    expect(cli).toContain("Central DB not available (better-sqlite3 missing).");
    expect(cli).toContain("outputResult(!!opts.json,");
    expect(cli).toContain("machineId: machine.machineId");
    expect(cli).toContain("Scanned ${result.roots.length} root(s); registered ${result.entries.length} project(s):");
  });

  it("exports scanProjects with project discovery markers", () => {
    expect(projectScan).toContain("export async function scanProjects");
    expect(projectScan).toContain("export async function findProjectDirs");
    expect(projectScan).toContain("recordLocation");
    expect(projectScan).toContain("readProjectIdentity");
  });
});
