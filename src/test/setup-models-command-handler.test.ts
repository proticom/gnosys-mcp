import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup models command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("wires setup models to runModelsSetup with provider/model/validate options", () => {
    expect(cli).toContain('.command("models")');
    expect(cli).toContain('const { runModelsSetup } = await import("./lib/setup.js")');
    expect(cli).toContain("provider: opts.provider");
    expect(cli).toContain("model: opts.model");
    expect(cli).toContain("validate: opts.validate");
  });
});
