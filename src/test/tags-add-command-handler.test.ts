import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys tags-add command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/tagsAddCommand.ts"),
    "utf-8",
  );

  it("wires tags-add to runTagsAddCommand via dynamic import", () => {
    expect(cli).toContain('.command("tags-add")');
    expect(cli).toContain("--category <category>");
    expect(cli).toContain("--tag <tag>");
    expect(cli).toContain(
      'const { runTagsAddCommand } = await import("./lib/tagsAddCommand.js")',
    );
    expect(cli).toContain("await runTagsAddCommand(getResolver, opts)");
  });

  it("exports runTagsAddCommand with tags-add markers", () => {
    expect(handler).toContain("export async function runTagsAddCommand");
    expect(handler).toContain("getResolver()");
    expect(handler).toContain("resolver.getWriteTarget()");
    expect(handler).toContain("No store found.");
    expect(handler).toContain("new GnosysTagRegistry");
    expect(handler).toContain("writeTarget.store.getStorePath()");
    expect(handler).toContain("tagRegistry.load()");
    expect(handler).toContain("tagRegistry.addTag(opts.category, opts.tag)");
    expect(handler).toContain("added to category");
    expect(handler).toContain("already exists");
  });
});
