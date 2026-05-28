import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys web remove command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/webRemoveCommand.ts"),
    "utf-8",
  );

  it("wires web remove to runWebRemoveCommand via dynamic import", () => {
    expect(cli).toContain('.command("web")');
    expect(cli).toContain('.command("remove <filepath>")');
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runWebRemoveCommand } = await import("./lib/webRemoveCommand.js")',
    );
    expect(cli).toContain("await runWebRemoveCommand(getWebStorePath, filepath, opts)");
  });

  it("exports runWebRemoveCommand with web remove markers", () => {
    expect(handler).toContain("export async function runWebRemoveCommand");
    expect(handler).toContain("loadConfig");
    expect(handler).toContain("buildIndex");
    expect(handler).toContain("writeIndex");
    expect(handler).toContain("fs/promises");
    expect(handler).toContain('webConfig?.outputDir || "./knowledge"');
    expect(handler).toContain("path.resolve(knowledgeRoot, filepath)");
    expect(handler).toContain("path.relative");
    expect(handler).toContain("path.isAbsolute(filepath)");
    expect(handler).toContain("relativePath.startsWith");
    expect(handler).toContain("Refusing to remove file outside knowledge directory");
    expect(handler).toContain("existsSync(fullPath)");
    expect(handler).toContain("File not found:");
    expect(handler).toContain("fsp.unlink(fullPath)");
    expect(handler).toContain('path.join(knowledgeRoot, "gnosys-index.json")');
    expect(handler).toContain("ok: true");
    expect(handler).toContain("removed:");
    expect(handler).toContain("documentCount");
    expect(handler).toContain("Removed:");
    expect(handler).toContain("Index rebuilt:");
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("Web remove failed:");
    expect(handler).toContain("process.exit(1)");
  });
});
