import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys dream log command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/dreamLogCommand.ts"),
    "utf-8",
  );

  it("wires dream log to runDreamLogCommand via dynamic import", () => {
    expect(cli).toContain('.command("log")');
    expect(cli).toContain("--last <N>");
    expect(cli).toContain("--since <YYYY-MM-DD>");
    expect(cli).toContain("--failures-only");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runDreamLogCommand } = await import("./lib/dreamLogCommand.js")',
    );
    expect(cli).toContain("parentJson: !!this.parent?.opts().json");
    expect(cli).toContain("await runDreamLogCommand(opts");
  });

  it("exports runDreamLogCommand with dream log markers", () => {
    expect(handler).toContain("export async function runDreamLogCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("Central DB not available.");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("Math.max(1, parseInt(opts.last) || 20)");
    expect(handler).toContain('`${opts.since}T00:00:00Z`');
    expect(handler).toContain("failuresOnly: !!opts.failuresOnly");
    expect(handler).toContain("context.parentJson");
    expect(handler).toContain("JSON.stringify({ count: runs.length, runs }, null, 2)");
    expect(handler).toContain("No dream runs recorded.");
    expect(handler).toContain("provider unreachable");
    expect(handler).toContain("centralDb?.close()");
  });
});
