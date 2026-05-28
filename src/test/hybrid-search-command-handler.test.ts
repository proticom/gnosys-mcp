import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys hybrid-search command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/hybridSearchCommand.ts"),
    "utf-8",
  );

  it("wires hybrid-search to runHybridSearchCommand via dynamic import", () => {
    expect(cli).toContain('.command("hybrid-search <query>")');
    expect(cli).toContain("-l, --limit <n>");
    expect(cli).toContain("-m, --mode <mode>");
    expect(cli).toContain("--federated");
    expect(cli).toContain("--scope <scope>");
    expect(cli).toContain(
      'const { runHybridSearchCommand } = await import("./lib/hybridSearchCommand.js")',
    );
    expect(cli).toContain(
      "await runHybridSearchCommand(getResolver, query, opts)",
    );
  });

  it("exports runHybridSearchCommand with federated and local hybrid markers", () => {
    expect(handler).toContain("export async function runHybridSearchCommand");
    expect(handler).toContain("federatedSearch");
    expect(handler).toContain("detectCurrentProject");
    expect(handler).toContain("new GnosysSearch(storePath)");
    expect(handler).toContain("new GnosysEmbeddings(storePath)");
    expect(handler).toContain("new GnosysHybridSearch");
    expect(handler).toContain("hybridSearch.hybridSearch(query");
    expect(handler).toContain("GnosysMaintenanceEngine.reinforceBatch");
    expect(handler).toContain("search.close()");
    expect(handler).toContain("embeddings.close()");
    expect(handler).toContain('await import("./federated.js")');
    expect(handler).toContain('await import("./embeddings.js")');
    expect(handler).not.toContain('await import("./lib/federated.js")');
  });
});
