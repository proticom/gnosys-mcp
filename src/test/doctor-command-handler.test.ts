import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys doctor command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handlers = readFileSync(
    join(process.cwd(), "src/lib/doctorCommand.ts"),
    "utf-8",
  );

  it("wires doctor to runDoctorCommand via dynamic import", () => {
    expect(cli).toContain('.command("doctor")');
    expect(cli).toContain(
      '.description("Check system health: stores, LLM connectivity, embeddings, archive")',
    );
    expect(cli).toContain(
      '.option("--fix", "Offer interactive cleanup of legacy artifacts (e.g. per-store gnosys.db)")',
    );
    expect(cli).toContain(
      'const { runDoctorCommand } = await import("./lib/doctorCommand.js")',
    );
    expect(cli).toContain("await runDoctorCommand(getResolver, opts)");
  });

  it("exports runDoctorCommand handler", () => {
    expect(handlers).toContain("export async function runDoctorCommand");
  });

  it("uses correct relative imports for archive and embeddings", () => {
    expect(handlers).toContain('await import("./archive.js")');
    expect(handlers).toContain('await import("./embeddings.js")');
    expect(handlers).not.toContain('await import("./lib/archive.js")');
    expect(handlers).not.toContain('await import("./lib/embeddings.js")');
  });
});
