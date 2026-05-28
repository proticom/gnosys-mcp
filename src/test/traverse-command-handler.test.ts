import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys traverse command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/traverseCommand.ts"),
    "utf-8",
  );

  it("wires traverse to runTraverseCommand via dynamic import", () => {
    expect(cli).toContain('.command("traverse <memoryId>")');
    expect(cli).toContain("-d, --depth <n>");
    expect(cli).toContain("--rel-types <types>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runTraverseCommand } = await import("./lib/traverseCommand.js")',
    );
    expect(cli).toContain("await runTraverseCommand(memoryId, opts)");
  });

  it("exports runTraverseCommand with traverse markers", () => {
    expect(handler).toContain("export async function runTraverseCommand");
    expect(handler).toContain("GnosysDB");
    expect(handler).toContain("handleRequest");
    expect(handler).toContain("GnosysDBClass.getCentralDbDir()");
    expect(handler).toContain("new GnosysDBClass(dbDir)");
    expect(handler).toContain("db.isAvailable()");
    expect(handler).toContain("better-sqlite3");
    expect(handler).toContain("id: memoryId");
    expect(handler).toContain("depth: opts.depth ? parseInt(opts.depth, 10) : 3");
    expect(handler).toContain('opts.relTypes.split(",")');
    expect(handler).toContain(".trim()");
    expect(handler).toContain('id: "cli-traverse"');
    expect(handler).toContain('method: "traverse"');
    expect(handler).toContain("if (opts.json)");
    expect(handler).toContain("error: res.error");
    expect(handler).toContain("Traverse failed:");
    expect(handler).toContain("db?.close()");
    expect(handler).toContain("finally");
    expect(handler).toContain("JSON.stringify(result, null, 2)");
    expect(handler).toContain("Traversal from");
    expect(handler).toContain("Total nodes:");
    expect(handler).toContain("node.confidence.toFixed(2)");
    expect(handler).toContain("via_rel");
    expect(handler).toContain("via_from");
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("process.exit(1)");
  });
});
