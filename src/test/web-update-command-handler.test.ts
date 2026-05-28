import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys web update command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/webUpdateCommand.ts"),
    "utf-8",
  );

  it("wires web update to runWebUpdateCommand via dynamic import", () => {
    expect(cli).toContain('.command("web")');
    expect(cli).toContain('.command("update <urlOrPath>")');
    expect(cli).toContain("--no-llm");
    expect(cli).toContain("--category <name>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runWebUpdateCommand } = await import("./lib/webUpdateCommand.js")',
    );
    expect(cli).toContain("await runWebUpdateCommand(getWebStorePath, urlOrPath, opts)");
  });

  it("exports runWebUpdateCommand with web update markers", () => {
    expect(handler).toContain("export async function runWebUpdateCommand");
    expect(handler).toContain("loadConfig");
    expect(handler).toContain("ingestUrl");
    expect(handler).toContain("buildIndex");
    expect(handler).toContain("writeIndex");
    expect(handler).toContain("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
    expect(handler).toContain('startsWith("http://") || urlOrPath.startsWith("https://")');
    expect(handler).toContain('source: "urls"');
    expect(handler).toContain("outputDir: knowledgeDir");
    expect(handler).toContain("opts.llm ? webConfig.llmEnrich : false");
    expect(handler).toContain("prune: false");
    expect(handler).toContain("concurrency: 1");
    expect(handler).toContain("crawlDelayMs: 0");
    expect(handler).toContain("path.relative");
    expect(handler).toContain("path.isAbsolute(urlOrPath)");
    expect(handler).toContain("relativePath.startsWith");
    expect(handler).toContain("Refusing to refresh file outside knowledge directory");
    expect(handler).toContain("File not found:");
    expect(handler).toContain("ok: true");
    expect(handler).toContain("documentCount");
    expect(handler).toContain("refreshed:");
    expect(handler).toContain("Updated:");
    expect(handler).toContain("Refreshed:");
    expect(handler).toContain("Index rebuilt:");
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("Web update failed:");
    expect(handler).toContain("process.exit(1)");
  });
});
