import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys web status command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/webStatusCommand.ts"),
    "utf-8",
  );

  it("wires web status to runWebStatusCommand via dynamic import", () => {
    expect(cli).toContain('.command("web")');
    expect(cli).toContain('.command("status")');
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runWebStatusCommand } = await import("./lib/webStatusCommand.js")',
    );
    expect(cli).toContain("await runWebStatusCommand(getWebStorePath, opts)");
  });

  it("exports runWebStatusCommand with web status markers", () => {
    expect(handler).toContain("export async function runWebStatusCommand");
    expect(handler).toContain("loadConfig");
    expect(handler).toContain("readdirSync");
    expect(handler).toContain("statSync");
    expect(handler).toContain('webConfig?.outputDir || "./knowledge"');
    expect(handler).toContain("Knowledge directory not found");
    expect(handler).toContain("Run 'gnosys web init' to get started.");
    expect(handler).toContain('exists: false, message: "Knowledge directory not found"');
    expect(handler).toContain("readdirSync(dir, { withFileTypes: true })");
    expect(handler).toContain('entry.name.endsWith(".md")');
    expect(handler).toContain('path.join(resolvedDir, "gnosys-index.json")');
    expect(handler).toContain("documentCount");
    expect(handler).toContain("generated");
    expect(handler).toContain("indexInfo = { exists: true, size: stat.size }");
    expect(handler).toContain("ok: true");
    expect(handler).toContain("knowledgeDir: resolvedDir");
    expect(handler).toContain("totalFiles");
    expect(handler).toContain("categoryCounts");
    expect(handler).toContain("index: indexInfo");
    expect(handler).toContain("Web Knowledge Base Status:");
    expect(handler).toContain("Directory:");
    expect(handler).toContain("Total files:");
    expect(handler).toContain("By category:");
    expect(handler).toContain("Index:");
    expect(handler).toContain("Last built:");
    expect(handler).toContain("Index: not built (run 'gnosys web build-index')");
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("Web status failed:");
    expect(handler).toContain("process.exit(1)");
  });
});
