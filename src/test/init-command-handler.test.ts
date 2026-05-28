import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys init command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("wires init options, project registration, and IDE hooks", () => {
    expect(cli).toContain('.command("init")');
    expect(cli).toContain('.option("-d, --directory <dir>", "Target directory (default: cwd)")');
    expect(cli).toContain('.option("-n, --name <name>", "Project name (default: directory basename)")');
    expect(cli).toContain("await createProjectIdentity(targetDir");
    expect(cli).toContain("await tempResolver.registerProject(targetDir)");
    expect(cli).toContain('const { configureIdeHooks } = await import("./lib/projectIdentity.js")');
    expect(cli).toContain("const hookResult = await configureIdeHooks(targetDir)");
    expect(cli).toContain("gnosys setup ides");
  });
});
