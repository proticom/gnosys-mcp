import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys read command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/readCommand.ts"),
    "utf-8",
  );

  it("wires read to runReadCommand via dynamic import", () => {
    expect(cli).toContain('.command("read <memoryPath>")');
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runReadCommand } = await import("./lib/readCommand.js")',
    );
    expect(cli).toContain("await runReadCommand(getResolver, memoryPath, opts)");
  });

  it("exports runReadCommand with DB-first and resolver fallback markers", () => {
    expect(handler).toContain("export async function runReadCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("centralDb.getMemory(memoryPath)");
    expect(handler).toContain("centralDb.close()");
    expect(handler).toContain("[Source: gnosys.db]");
    expect(handler).toContain("source_file:");
    expect(handler).toContain("source_path:");
    expect(handler).toContain("resolver.readMemory(memoryPath)");
    expect(handler).toContain("Memory not found:");
    expect(handler).toContain("fs.readFile(memory.filePath");
    expect(handler).toContain("outputResult(!!opts.json");
  });
});
