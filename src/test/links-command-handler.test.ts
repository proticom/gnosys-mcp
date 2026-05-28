import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys links command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/linksCommand.ts"),
    "utf-8",
  );

  it("wires links to runLinksCommand via dynamic import", () => {
    expect(cli).toContain('.command("links <memoryPath>")');
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runLinksCommand } = await import("./lib/linksCommand.js")',
    );
    expect(cli).toContain("await runLinksCommand(getResolver, memoryPath, opts)");
  });

  it("exports runLinksCommand with links markers", () => {
    expect(handler).toContain("export async function runLinksCommand");
    expect(handler).toContain("getResolver()");
    expect(handler).toContain("resolver.readMemory(memoryPath)");
    expect(handler).toContain("Memory not found:");
    expect(handler).toContain("resolver.getAllMemories()");
    expect(handler).toContain("getOutgoingLinks(allMemories, memory.relativePath)");
    expect(handler).toContain("getBacklinks(allMemories, memory.relativePath)");
    expect(handler).toContain("outputResult(!!opts.json");
    expect(handler).toContain("memoryPath");
    expect(handler).toContain("outgoing");
    expect(handler).toContain("backlinks");
    expect(handler).toContain("No outgoing links.");
    expect(handler).toContain("No backlinks.");
    expect(handler).toContain('from "./wikilinks.js"');
  });
});
