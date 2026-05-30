import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys dream report command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/dreamReport.ts"),
    "utf-8",
  );

  it("wires dream report to runDreamReportCommand via dynamic import", () => {
    expect(cli).toContain('.command("report")');
    expect(cli).toContain("Generate an HTML dashboard from ~/.gnosys/dream-runs.jsonl");
    expect(cli).toContain("--output");
    expect(cli).toContain("--last");
    expect(cli).toContain(
      'const { runDreamReportCommand } = await import("./lib/dreamReport.js")',
    );
    expect(cli).toContain("await runDreamReportCommand(opts)");
  });

  it("exports runDreamReportCommand with dream report markers", () => {
    expect(handler).toContain("export async function runDreamReportCommand");
    expect(handler).toContain("readDreamRuns");
    expect(handler).toContain("generateDreamDashboardHtml");
    expect(handler).toContain('opts.output || "dream-dashboard.html"');
    expect(handler).toContain("parseInt(opts.last, 10)");
    expect(handler).toContain("Wrote ${output}");
    expect(handler).toContain("escapeHtml");
  });
});
