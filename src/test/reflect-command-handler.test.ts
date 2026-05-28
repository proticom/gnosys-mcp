import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys reflect command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/reflectCommand.ts"),
    "utf-8",
  );

  it("wires reflect to runReflectCommand via dynamic import", () => {
    expect(cli).toContain('.command("reflect <outcome>")');
    expect(cli).toContain("--memory-ids <ids>");
    expect(cli).toContain("--failure");
    expect(cli).toContain("--notes <text>");
    expect(cli).toContain("--confidence-delta <n>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runReflectCommand } = await import("./lib/reflectCommand.js")',
    );
    expect(cli).toContain("await runReflectCommand(outcome, opts)");
  });

  it("exports runReflectCommand with reflect markers", () => {
    expect(handler).toContain("export async function runReflectCommand");
    expect(handler).toContain("GnosysDB");
    expect(handler).toContain("handleRequest");
    expect(handler).toContain("GnosysDBClass.getCentralDbDir()");
    expect(handler).toContain("db.isAvailable()");
    expect(handler).toContain("better-sqlite3");
    expect(handler).toContain("success: !opts.failure");
    expect(handler).toContain('opts.memoryIds.split(",")');
    expect(handler).toContain(".trim()");
    expect(handler).toContain("params.notes = opts.notes");
    expect(handler).toContain("params.confidence_delta = parseFloat(opts.confidenceDelta)");
    expect(handler).toContain('id: "cli-reflect"');
    expect(handler).toContain('method: "reflect"');
    expect(handler).toContain("Reflect failed:");
    expect(handler).toContain("if (opts.json)");
    expect(handler).toContain("error: res.error");
    expect(handler).toContain("db?.close()");
    expect(handler).toContain("finally");
    expect(handler).toContain("JSON.stringify(result, null, 2)");
    expect(handler).toContain("Reflection recorded:");
    expect(handler).toContain("reflection_id");
    expect(handler).toContain("Memories updated:");
    expect(handler).toContain("Relationships created:");
    expect(handler).toContain("Confidence delta:");
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("process.exit(1)");
  });
});
