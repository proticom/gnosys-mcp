import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys web build-index command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/webBuildIndexCommand.ts"),
    "utf-8",
  );

  it("wires web build-index to runWebBuildIndexCommand via dynamic import", () => {
    expect(cli).toContain('.command("web")');
    expect(cli).toContain('.command("build-index")');
    expect(cli).toContain("--input <dir>");
    expect(cli).toContain("--output <path>");
    expect(cli).toContain("--no-stop-words");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runWebBuildIndexCommand } = await import("./lib/webBuildIndexCommand.js")',
    );
    expect(cli).toContain("await runWebBuildIndexCommand(getWebStorePath, opts)");
  });

  it("exports runWebBuildIndexCommand with web build-index markers", () => {
    expect(handler).toContain("export async function runWebBuildIndexCommand");
    expect(handler).toContain('await import("./config.js")');
    expect(handler).toContain('await import("./webIndex.js")');
    expect(handler).toContain("loadConfig");
    expect(handler).toContain("buildIndex");
    expect(handler).toContain("writeIndex");
    expect(handler).toContain('opts.input || gnosysConfig.web?.outputDir || "./knowledge"');
    expect(handler).toContain('path.join(knowledgeDir, "gnosys-index.json")');
    expect(handler).toContain("stopWords: opts.stopWords");
    expect(handler).toContain("ok: true");
    expect(handler).toContain("documentCount");
    expect(handler).toContain("tokenCount");
    expect(handler).toContain("outputPath");
    expect(handler).toContain("Search index built:");
    expect(handler).toContain("Documents:");
    expect(handler).toContain("Tokens:");
    expect(handler).toContain("Output:");
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("Build index failed:");
    expect(handler).toContain("process.exit(1)");
  });
});
