import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys web build command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/webBuildCommand.ts"),
    "utf-8",
  );

  it("wires web build to runWebBuildCommand via dynamic import", () => {
    expect(cli).toContain('.command("web")');
    expect(cli).toContain('.command("build")');
    expect(cli).toContain("--source <url>");
    expect(cli).toContain("--prune");
    expect(cli).toContain("--no-llm");
    expect(cli).toContain("--concurrency <n>");
    expect(cli).toContain("--dry-run");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runWebBuildCommand } = await import("./lib/webBuildCommand.js")',
    );
    expect(cli).toContain("await runWebBuildCommand(getWebStorePath, opts)");
  });

  it("exports runWebBuildCommand with web build markers", () => {
    expect(handler).toContain("export async function runWebBuildCommand");
    expect(handler).toContain("loadConfig");
    expect(handler).toContain("ingestSite");
    expect(handler).toContain("buildIndex");
    expect(handler).toContain("writeIndex");
    expect(handler).toContain("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
    expect(handler).toContain("opts.source || webConfig.sitemapUrl");
    expect(handler).toContain("opts.source || webConfig.contentDir");
    expect(handler).toContain("urls: webConfig.urls");
    expect(handler).toContain("outputDir: webConfig.outputDir");
    expect(handler).toContain("exclude: webConfig.exclude");
    expect(handler).toContain("categories: webConfig.categories");
    expect(handler).toContain("opts.llm ? webConfig.llmEnrich : false");
    expect(handler).toContain("opts.prune || webConfig.prune");
    expect(handler).toContain("parseInt(opts.concurrency)");
    expect(handler).toContain("crawlDelayMs: webConfig.crawlDelayMs");
    expect(handler).toContain("dryRun: opts.dryRun");
    expect(handler).toContain("if (!opts.dryRun)");
    expect(handler).toContain('path.join(webConfig.outputDir, "gnosys-index.json")');
    expect(handler).toContain("index: indexStats");
    expect(handler).toContain("Web build complete");
    expect(handler).toContain("Added:");
    expect(handler).toContain("Updated:");
    expect(handler).toContain("Unchanged:");
    expect(handler).toContain("Removed:");
    expect(handler).toContain("Index:");
    expect(handler).toContain("Errors:");
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("Web build failed:");
    expect(handler).toContain("process.exit(1)");
  });
});
