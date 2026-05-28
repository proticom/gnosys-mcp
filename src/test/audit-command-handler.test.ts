import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys audit command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/auditCommand.ts"),
    "utf-8",
  );

  it("wires audit to runAuditCommand via dynamic import", () => {
    expect(cli).toContain('.command("audit")');
    expect(cli).toContain("--days <n>");
    expect(cli).toContain("--operation <op>");
    expect(cli).toContain("--limit <n>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runAuditCommand } = await import("./lib/auditCommand.js")',
    );
    expect(cli).toContain("await runAuditCommand(opts)");
  });

  it("exports runAuditCommand with audit markers", () => {
    expect(handler).toContain("export async function runAuditCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("Central DB unavailable.");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("readAuditFromDb");
    expect(handler).toContain("formatAuditTimeline");
    expect(handler).toContain("parseInt(opts.days, 10)");
    expect(handler).toContain("opts.limit ? parseInt(opts.limit, 10) : undefined");
    expect(handler).toContain("JSON.stringify(entries, null, 2)");
    expect(handler).toContain("centralDb?.close()");
  });
});
