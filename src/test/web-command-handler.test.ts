import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys web parent command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("declares web as a parent container with leaf subcommand handlers", () => {
    expect(cli).toContain("const webCmd = program");
    expect(cli).toContain('.command("web")');
    expect(cli).toContain(
      "Web Knowledge Base — generate searchable knowledge from websites",
    );

    expect(cli).toContain('.command("init")');
    expect(cli).toContain(
      'const { runWebInitCommand } = await import("./lib/webInitCommand.js")',
    );
    expect(cli).toContain("await runWebInitCommand(getWebStorePath, opts)");

    expect(cli).toContain('.command("ingest")');
    expect(cli).toContain(
      'const { runWebIngestCommand } = await import("./lib/webIngestCommand.js")',
    );
    expect(cli).toContain("await runWebIngestCommand(getWebStorePath, opts)");

    expect(cli).toContain('.command("build-index")');
    expect(cli).toContain(
      'const { runWebBuildIndexCommand } = await import("./lib/webBuildIndexCommand.js")',
    );
    expect(cli).toContain("await runWebBuildIndexCommand(getWebStorePath, opts)");

    expect(cli).toContain('.command("build")');
    expect(cli).toContain(
      'const { runWebBuildCommand } = await import("./lib/webBuildCommand.js")',
    );
    expect(cli).toContain("await runWebBuildCommand(getWebStorePath, opts)");

    expect(cli).toContain('.command("add <url>")');
    expect(cli).toContain(
      'const { runWebAddCommand } = await import("./lib/webAddCommand.js")',
    );
    expect(cli).toContain("await runWebAddCommand(getWebStorePath, url, opts)");

    expect(cli).toContain('.command("remove <filepath>")');
    expect(cli).toContain(
      'const { runWebRemoveCommand } = await import("./lib/webRemoveCommand.js")',
    );
    expect(cli).toContain("await runWebRemoveCommand(getWebStorePath, filepath, opts)");

    expect(cli).toContain('.command("update <urlOrPath>")');
    expect(cli).toContain(
      'const { runWebUpdateCommand } = await import("./lib/webUpdateCommand.js")',
    );
    expect(cli).toContain("await runWebUpdateCommand(getWebStorePath, urlOrPath, opts)");

    expect(cli).toContain('.command("status")');
    expect(cli).toContain(
      'const { runWebStatusCommand } = await import("./lib/webStatusCommand.js")',
    );
    expect(cli).toContain("await runWebStatusCommand(getWebStorePath, opts)");
  });

  it("has no parent action between web declaration and first leaf command", () => {
    const webStart = cli.indexOf("const webCmd = program");
    const firstLeaf = cli.indexOf('webCmd\n  .command("init")', webStart);
    expect(webStart).toBeGreaterThan(-1);
    expect(firstLeaf).toBeGreaterThan(webStart);

    const parentBlock = cli.slice(webStart, firstLeaf);
    expect(parentBlock).not.toContain(".action(");
  });
});
