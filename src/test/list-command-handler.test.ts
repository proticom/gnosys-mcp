import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys list command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/listCommand.ts"),
    "utf-8",
  );

  it("wires list to runListCommand via dynamic import", () => {
    expect(cli).toContain('.command("list")');
    expect(cli).toContain("-c, --category <category>");
    expect(cli).toContain("-t, --tag <tag>");
    expect(cli).toContain("-s, --store <store>");
    expect(cli).toContain("--json");
    expect(cli).toContain("--id-format <format>");
    expect(cli).toContain(
      'const { runListCommand } = await import("./lib/listCommand.js")',
    );
    expect(cli).toContain("await runListCommand(opts)");
  });

  it("exports runListCommand with list markers", () => {
    expect(handler).toContain("export async function runListCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("isAvailable()");
    expect(handler).toContain("findProjectIdentity(process.cwd())");
    expect(handler).toContain("getActiveMemories()");
    expect(handler).toContain("m.scope === opts.store");
    expect(handler).toContain("m.category === opts.category");
    expect(handler).toContain("tags.includes(opts.tag!)");
    expect(handler).toContain("formatMemoryIdHyperlink");
    expect(handler).toContain("buildProjectNameLookup");
    expect(handler).toContain("parseIdFormat(opts.idFormat)");
    expect(handler).toContain("outputResult(!!opts.json");
    expect(handler).toContain('logError(err, { module: "cli", op: "list" })');
    expect(handler).toContain("centralDb?.close()");
    expect(handler).toContain('await import("./idFormat.js")');
    expect(handler).not.toContain('await import("./lib/idFormat.js")');
  });
});
