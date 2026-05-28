import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys recall command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/recallCommand.ts"),
    "utf-8",
  );

  it("wires recall to runRecallCommand via dynamic import", () => {
    expect(cli).toContain('.command("recall <query>")');
    expect(cli).toContain("--aggressive");
    expect(cli).toContain("--trace-id <id>");
    expect(cli).toContain("--host");
    expect(cli).toContain("--federated");
    expect(cli).toContain(
      'const { runRecallCommand } = await import("./lib/recallCommand.js")',
    );
    expect(cli).toContain("await runRecallCommand(query, opts)");
  });

  it("exports runRecallCommand with federated and legacy audit markers", () => {
    expect(handler).toContain("export async function runRecallCommand");
    expect(handler).toContain("federatedSearch");
    expect(handler).toContain("<gnosys-recall");
    expect(handler).toContain("new GnosysResolver()");
    expect(handler).toContain("initAudit(storePath)");
    expect(handler).toContain("recall(query");
    expect(handler).toContain("formatRecall(result)");
    expect(handler).toContain("formatRecallCLI(result)");
    expect(handler).toContain("closeAudit()");
    expect(handler).toContain('await import("./recall.js")');
    expect(handler).toContain('await import("./audit.js")');
    expect(handler).not.toContain('await import("./lib/recall.js")');
  });
});
