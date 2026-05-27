import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup preferences command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("wires setup preferences to runPreferencesReview with readline cleanup", () => {
    expect(cli).toContain('.command("preferences")');
    expect(cli).toContain('const readline = await import("readline/promises")');
    expect(cli).toContain('const { runPreferencesReview } = await import("./lib/setup/sections/preferences.js")');
    expect(cli).toContain("await runPreferencesReview(rl)");
    expect(cli).toContain("rl.close()");
  });
});
