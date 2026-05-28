import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys tags command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/tagsCommand.ts"),
    "utf-8",
  );

  it("wires tags to runTagsCommand via dynamic import", () => {
    expect(cli).toContain('.command("tags")');
    expect(cli).toContain('.description("List all tags in the registry")');
    expect(cli).toContain(
      'const { runTagsCommand } = await import("./lib/tagsCommand.js")',
    );
    expect(cli).toContain("await runTagsCommand(getResolver)");
  });

  it("exports runTagsCommand with tags markers", () => {
    expect(handler).toContain("export async function runTagsCommand");
    expect(handler).toContain("getResolver()");
    expect(handler).toContain("resolver.getWriteTarget()");
    expect(handler).toContain("No store found.");
    expect(handler).toContain("new GnosysTagRegistry");
    expect(handler).toContain("writeTarget.store.getStorePath()");
    expect(handler).toContain("tagRegistry.load()");
    expect(handler).toContain("tagRegistry.getRegistry()");
    expect(handler).toContain("tags.sort().join");
  });
});
