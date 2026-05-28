import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys history command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/historyCommand.ts"),
    "utf-8",
  );

  it("wires history to runHistoryCommand via dynamic import", () => {
    expect(cli).toContain('.command("history <memoryPath>")');
    expect(cli).toContain("-n, --limit <number>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runHistoryCommand } = await import("./lib/historyCommand.js")',
    );
    expect(cli).toContain("await runHistoryCommand(memoryPath, opts)");
  });

  it("exports runHistoryCommand with history markers", () => {
    expect(handler).toContain("export async function runHistoryCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("isAvailable()");
    expect(handler).toContain("centralDb.getMemory(memoryPath)");
    expect(handler).toContain("Memory not found:");
    expect(handler).toContain("parseInt(opts.limit, 10) || 20");
    expect(handler).toContain("centralDb.getAuditLog(dbMem.id, limit)");
    expect(handler).toContain("memoryId");
    expect(handler).toContain("title");
    expect(handler).toContain("created");
    expect(handler).toContain("modified");
    expect(handler).toContain("entries");
    expect(handler).toContain("No audit history recorded.");
    expect(handler).toContain("History for");
    expect(handler).toContain('entry.timestamp.split("T")[0]');
    expect(handler).toContain("entry.details");
    expect(handler).toContain("centralDb.close()");
    expect(handler).toContain("outputResult(!!opts.json");
  });
});
