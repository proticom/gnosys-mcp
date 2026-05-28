import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys trace command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/traceCommand.ts"),
    "utf-8",
  );

  it("wires trace to runTraceCommand via dynamic import", () => {
    expect(cli).toContain('.command("trace <directory>")');
    expect(cli).toContain("--max-files <n>");
    expect(cli).toContain("--project-id <id>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runTraceCommand } = await import("./lib/traceCommand.js")',
    );
    expect(cli).toContain("await runTraceCommand(directory, opts)");
  });

  it("exports runTraceCommand with trace markers", () => {
    expect(handler).toContain("export async function runTraceCommand");
    expect(handler).toContain("traceCodebase");
    expect(handler).toContain("GnosysDB");
    expect(handler).toContain("GnosysDBClass.getCentralDbDir()");
    expect(handler).toContain("new GnosysDBClass(dbDir)");
    expect(handler).toContain("db.isAvailable()");
    expect(handler).toContain("better-sqlite3");
    expect(handler).toContain("traceCodebase(db, directory");
    expect(handler).toContain("projectId: opts.projectId");
    expect(handler).toContain("maxFiles: opts.maxFiles ? parseInt(opts.maxFiles, 10) : undefined");
    expect(handler).toContain("db?.close()");
    expect(handler).toContain("finally");
    expect(handler).toContain("Trace complete:");
    expect(handler).toContain("Files scanned:");
    expect(handler).toContain("Functions found:");
    expect(handler).toContain("Memories created:");
    expect(handler).toContain("Relationships created:");
    expect(handler).toContain('JSON.stringify({ ok: false');
    expect(handler).toContain("Trace failed:");
    expect(handler).toContain("process.exit(1)");
  });
});
