import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys reinforce command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/reinforceCommand.ts"),
    "utf-8",
  );

  it("wires reinforce to runReinforceCommand via dynamic import", () => {
    expect(cli).toContain('.command("reinforce <memoryId>")');
    expect(cli).toContain("--signal <signal>");
    expect(cli).toContain("--context <context>");
    expect(cli).toContain(
      'const { runReinforceCommand } = await import("./lib/reinforceCommand.js")',
    );
    expect(cli).toContain("await runReinforceCommand(getResolver, memoryId, opts)");
  });

  it("exports runReinforceCommand with reinforce markers", () => {
    expect(handler).toContain("export async function runReinforceCommand");
    expect(handler).toContain("getResolver()");
    expect(handler).toContain("getWriteTarget()");
    expect(handler).toContain("No writable store found.");
    expect(handler).toContain('".config"');
    expect(handler).toContain("reinforcement.log");
    expect(handler).toContain("memory_id");
    expect(handler).toContain("signal");
    expect(handler).toContain("context");
    expect(handler).toContain("timestamp");
    expect(handler).toContain("fs.appendFile");
    expect(handler).toContain('opts.signal === "useful"');
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("syncUpdateToDb");
    expect(handler).toContain("centralDb?.close()");
    expect(handler).toContain("reinforced. Decay clock reset.");
    expect(handler).toContain("Routing feedback logged");
    expect(handler).toContain("flagged for review as outdated");
    expect(handler).toContain('await import("./dbWrite.js")');
  });
});
