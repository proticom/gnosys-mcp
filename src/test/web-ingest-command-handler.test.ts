import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys web ingest command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/webIngestCommand.ts"),
    "utf-8",
  );

  it("wires web ingest to runWebIngestCommand via dynamic import", () => {
    expect(cli).toContain('.command("web")');
    expect(cli).toContain('.command("ingest")');
    expect(cli).toContain("--source <url>");
    expect(cli).toContain("--prune");
    expect(cli).toContain("--no-llm");
    expect(cli).toContain("--concurrency <n>");
    expect(cli).toContain("--dry-run");
    expect(cli).toContain("--verbose");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runWebIngestCommand } = await import("./lib/webIngestCommand.js")',
    );
    expect(cli).toContain("await runWebIngestCommand(getWebStorePath, opts)");
  });

  it("exports runWebIngestCommand with web ingest markers", () => {
    expect(handler).toContain("export async function runWebIngestCommand");
    expect(handler).toContain('await import("./config.js")');
    expect(handler).toContain('await import("./webIngest.js")');
    expect(handler).toContain("loadConfig");
    expect(handler).toContain("ingestSite");
    expect(handler).toContain("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
    expect(handler).toContain("opts.source || webConfig.sitemapUrl");
    expect(handler).toContain("opts.source || webConfig.contentDir");
    expect(handler).toContain("opts.llm ? webConfig.llmEnrich : false");
    expect(handler).toContain("opts.prune || webConfig.prune");
    expect(handler).toContain("parseInt(opts.concurrency)");
    expect(handler).toContain("opts.dryRun");
    expect(handler).toContain("opts.verbose");
    expect(handler).toContain("JSON.stringify(result, null, 2)");
    expect(handler).toContain("Ingestion complete");
    expect(handler).toContain("Added:");
    expect(handler).toContain("Updated:");
    expect(handler).toContain("Unchanged:");
    expect(handler).toContain("Removed:");
    expect(handler).toContain("result.errors");
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("Ingest failed:");
    expect(handler).toContain("process.exit(1)");
  });
});
