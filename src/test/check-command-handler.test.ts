import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys check command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/checkCommand.ts"),
    "utf-8",
  );

  it("wires check to runCheckCommand via dynamic import", () => {
    expect(cli).toContain('.command("check")');
    expect(cli).toContain("--task <name>");
    expect(cli).toContain(
      'const { runCheckCommand } = await import("./lib/checkCommand.js")',
    );
    expect(cli).toContain("await runCheckCommand(opts)");
  });

  it("exports runCheckCommand with check markers", () => {
    expect(handler).toContain("export async function runCheckCommand");
    expect(handler).toContain("loadConfig(storePath)");
    expect(handler).toContain("loadConfig(globalStorePath)");
    expect(handler).toContain("getGnosysHome()");
    expect(handler).toContain('name: "structuring"');
    expect(handler).toContain('name: "synthesis"');
    expect(handler).toContain('name: "chat"');
    expect(handler).toContain('name: "vision"');
    expect(handler).toContain('name: "transcription"');
    expect(handler).toContain('name: "dream"');
    expect(handler).toContain("resolveTaskModel(cfg,");
    expect(handler).toContain("isProviderAvailable(cfg, provider");
    expect(handler).toContain("getLLMProvider(");
    expect(handler).toContain("testConnection()");
    expect(handler).toContain("!cfg.dream?.enabled");
    expect(handler).toContain("Unknown task:");
    expect(handler).toContain("All ${passed}/${total} tasks connected.");
  });
});
