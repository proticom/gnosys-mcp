import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys ambiguity command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/ambiguityCommand.ts"),
    "utf-8",
  );

  it("wires ambiguity to runAmbiguityCommand via dynamic import", () => {
    expect(cli).toContain('.command("ambiguity <query>")');
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runAmbiguityCommand } = await import("./lib/ambiguityCommand.js")',
    );
    expect(cli).toContain("await runAmbiguityCommand(query, opts)");
  });

  it("exports runAmbiguityCommand with ambiguity markers", () => {
    expect(handler).toContain("export async function runAmbiguityCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("Central DB not available.");
    expect(handler).toContain("detectAmbiguity");
    expect(handler).toContain('No ambiguity for "');
    expect(handler).toContain("ambiguous: !!ambiguity");
    expect(handler).toContain("ambiguity.candidates");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("centralDb?.close()");
  });
});
