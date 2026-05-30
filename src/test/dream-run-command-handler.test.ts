import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys dream run command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/dreamCommand.ts"),
    "utf-8",
  );

  it("wires bare dream and dream run to runDreamCommand via dynamic import", () => {
    expect(cli).toContain('.command("dream")');
    expect(cli).toContain('.command("run")');
    expect(cli).toContain("--max-runtime <minutes>");
    expect(cli).toContain("--no-critique");
    expect(cli).toContain("--no-summaries");
    expect(cli).toContain("--no-relationships");
    expect(cli).toContain("--force");
    expect(cli).toContain("--scheduled");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runDreamCommand } = await import("./lib/dreamCommand.js")',
    );
    expect(cli).toContain("await runDreamCommand(opts)");
  });

  it("exports runDreamCommand with dream cycle markers", () => {
    expect(handler).toContain("export async function runDreamCommand");
    expect(handler).toContain("new GnosysResolver()");
    expect(handler).toContain("No Gnosys stores found. Run 'gnosys init' first.");
    expect(handler).toContain("Dream Mode requires gnosys.db");
    expect(handler).toContain("getDreamMachineId()");
    expect(handler).toContain("opts.force");
    expect(handler).toContain("acquireDreamLock");
    expect(handler).toContain("isInsideNightWindow");
    expect(handler).toContain("getSystemIdleMinutes");
    expect(handler).toContain("countChangedMemoriesSince");
    expect(handler).toContain("appendDreamRun");
    expect(handler).toContain("GnosysDreamEngine");
    expect(handler).toContain("engine.dream");
    expect(handler).toContain("JSON.stringify(report, null, 2)");
    expect(handler).toContain("formatDreamReport(report)");
    expect(handler).toContain("db.close()");
  });
});
