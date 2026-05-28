import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys web init command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/webInitCommand.ts"),
    "utf-8",
  );

  it("wires web init to runWebInitCommand via dynamic import", () => {
    expect(cli).toContain('.command("web")');
    expect(cli).toContain('.command("init")');
    expect(cli).toContain("--source <type>");
    expect(cli).toContain("--output <dir>");
    expect(cli).toContain("--no-config");
    expect(cli).toContain("--non-interactive");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runWebInitCommand } = await import("./lib/webInitCommand.js")',
    );
    expect(cli).toContain("await runWebInitCommand(getWebStorePath, opts)");
  });

  it("exports runWebInitCommand with web init markers", () => {
    expect(handler).toContain("export async function runWebInitCommand");
    expect(handler).toContain("mkdirSync(outputDir, { recursive: true })");
    expect(handler).toContain("loadConfig");
    expect(handler).toContain("updateConfig");
    expect(handler).toContain("resolveTaskModel");
    expect(handler).toContain("createInterface");
    expect(handler).toContain("providerEnvVars");
    expect(handler).toContain("ANTHROPIC_API_KEY");
    expect(handler).toContain("OPENAI_API_KEY");
    expect(handler).toContain("opts.nonInteractive");
    expect(handler).toContain("opts.json");
    expect(handler).toContain("opts.config");
    expect(handler).toContain("source:");
    expect(handler).toContain("sitemapUrl");
    expect(handler).toContain("outputDir");
    expect(handler).toContain("exclude:");
    expect(handler).toContain("categories:");
    expect(handler).toContain("llmEnrich");
    expect(handler).toContain("prune:");
    expect(handler).toContain('JSON.stringify({ ok: true');
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("Created ${outputDir}/");
    expect(handler).toContain("Next steps:");
    expect(handler).toContain("process.exit(1)");
  });
});
