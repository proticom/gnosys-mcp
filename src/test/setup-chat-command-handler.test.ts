import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys setup chat command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");

  it("wires setup chat to runChatSetup with the current directory", () => {
    expect(cli).toContain('.command("chat")');
    expect(cli).toContain('const { runChatSetup } = await import("./lib/setup.js")');
    expect(cli).toContain("await runChatSetup({ directory: process.cwd() })");
  });
});
