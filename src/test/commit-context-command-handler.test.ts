import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys commit-context command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/commitContextCommand.ts"),
    "utf-8",
  );

  it("wires commit-context to runCommitContextCommand via dynamic import", () => {
    expect(cli).toContain('.command("commit-context <context>")');
    expect(cli).toContain("--dry-run");
    expect(cli).toContain("-s, --store <store>");
    expect(cli).toContain(
      'const { runCommitContextCommand } = await import("./lib/commitContextCommand.js")',
    );
    expect(cli).toContain(
      "await runCommitContextCommand(getResolver, resolveProjectId, context, opts)",
    );
  });

  it("exports runCommitContextCommand with extraction and commit markers", () => {
    expect(handler).toContain("export async function runCommitContextCommand");
    expect(handler).toContain("GnosysIngestion");
    expect(handler).toContain("GnosysSearch");
    expect(handler).toContain("getLLMProvider");
    expect(handler).toContain("JSON.parse");
    expect(handler).toContain("opts.dryRun");
    expect(handler).toContain("centralDb.insertMemory");
    expect(handler).toContain('await import("./ingest.js")');
    expect(handler).not.toContain('await import("./lib/ingest.js")');
  });
});
