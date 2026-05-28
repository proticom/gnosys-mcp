import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys web add command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/webAddCommand.ts"),
    "utf-8",
  );

  it("wires web add to runWebAddCommand via dynamic import", () => {
    expect(cli).toContain('.command("web")');
    expect(cli).toContain('.command("add <url>")');
    expect(cli).toContain("--category <name>");
    expect(cli).toContain("--no-llm");
    expect(cli).toContain("--no-reindex");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runWebAddCommand } = await import("./lib/webAddCommand.js")',
    );
    expect(cli).toContain("await runWebAddCommand(getWebStorePath, url, opts)");
  });

  it("exports runWebAddCommand with web add markers", () => {
    expect(handler).toContain("export async function runWebAddCommand");
    expect(handler).toContain("loadConfig");
    expect(handler).toContain("ingestUrl");
    expect(handler).toContain("buildIndex");
    expect(handler).toContain("writeIndex");
    expect(handler).toContain("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
    expect(handler).toContain('{ ...webConfig.categories, "/*": opts.category }');
    expect(handler).toContain('source: "urls"');
    expect(handler).toContain("outputDir: webConfig.outputDir");
    expect(handler).toContain("opts.llm ? webConfig.llmEnrich : false");
    expect(handler).toContain("concurrency: 1");
    expect(handler).toContain("crawlDelayMs: 0");
    expect(handler).toContain("opts.reindex && result.added.length + result.updated.length > 0");
    expect(handler).toContain('path.join(webConfig.outputDir, "gnosys-index.json")');
    expect(handler).toContain("JSON.stringify(result, null, 2)");
    expect(handler).toContain("Added:");
    expect(handler).toContain("Updated:");
    expect(handler).toContain("Unchanged (content identical)");
    expect(handler).toContain("Error:");
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("Web add failed:");
    expect(handler).toContain("process.exit(1)");
  });
});
