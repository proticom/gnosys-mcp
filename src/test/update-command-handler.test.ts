import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys update command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/updateCommand.ts"),
    "utf-8",
  );

  it("wires update to runUpdateCommand via dynamic import", () => {
    expect(cli).toContain('.command("update <memoryPath>")');
    expect(cli).toContain("--title <title>");
    expect(cli).toContain("--status <status>");
    expect(cli).toContain("--confidence <n>");
    expect(cli).toContain("--relevance <keywords>");
    expect(cli).toContain("--supersedes <id>");
    expect(cli).toContain("--superseded-by <id>");
    expect(cli).toContain("--content <content>");
    expect(cli).toContain(
      'const { runUpdateCommand } = await import("./lib/updateCommand.js")',
    );
    expect(cli).toContain("await runUpdateCommand(getResolver, memoryPath, opts)");
  });

  it("exports runUpdateCommand with update markers", () => {
    expect(handler).toContain("export async function runUpdateCommand");
    expect(handler).toContain("getResolver()");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("centralDb.getMemory(memoryPath)");
    expect(handler).toContain("resolver.readMemory(memoryPath)");
    expect(handler).toContain("Central DB not available.");
    expect(handler).toContain("Memory not found:");
    expect(handler).toContain("parseFloat(opts.confidence)");
    expect(handler).toContain("superseded_by");
    expect(handler).toContain("opts.title || currentTitle");
    expect(handler).toContain("syncUpdateToDb");
    expect(handler).toContain("Cross-linked:");
    expect(handler).toContain("centralDb?.close()");
    expect(handler).toContain("Memory updated:");
    expect(handler).toContain("ID:");
    expect(handler).toContain("Changed:");
    expect(handler).toContain('await import("./dbWrite.js")');
  });
});
