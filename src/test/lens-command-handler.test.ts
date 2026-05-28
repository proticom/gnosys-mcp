import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys lens command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/lensCommand.ts"),
    "utf-8",
  );

  it("wires lens to runLensCommand via dynamic import", () => {
    expect(cli).toContain('.command("lens")');
    expect(cli).toContain("-c, --category <category>");
    expect(cli).toContain("-t, --tag <tags...>");
    expect(cli).toContain("--match <mode>");
    expect(cli).toContain("--or");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runLensCommand } = await import("./lib/lensCommand.js")',
    );
    expect(cli).toContain("await runLensCommand(getResolver, opts)");
  });

  it("exports runLensCommand with lens markers", () => {
    expect(handler).toContain("export async function runLensCommand");
    expect(handler).toContain("getResolver()");
    expect(handler).toContain("resolver.getAllMemories()");
    expect(handler).toContain("const lens: LensFilter = {}");
    expect(handler).toContain('lens.operator = "OR"');
    expect(handler).toContain("applyLens(allMemories, lens)");
    expect(handler).toContain("outputResult(!!opts.json");
    expect(handler).toContain("No memories match the lens filter.");
    expect(handler).toContain("memories match:");
    expect(handler).toContain('from "./lensing.js"');
  });
});
