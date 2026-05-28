import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys semantic-search command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/semanticSearchCommand.ts"),
    "utf-8",
  );

  it("wires semantic-search to runSemanticSearchCommand via dynamic import", () => {
    expect(cli).toContain('.command("semantic-search <query>")');
    expect(cli).toContain("-l, --limit <n>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runSemanticSearchCommand } = await import("./lib/semanticSearchCommand.js")',
    );
    expect(cli).toContain(
      "await runSemanticSearchCommand(getResolver, query, opts)",
    );
  });

  it("exports runSemanticSearchCommand with semantic-only and cleanup markers", () => {
    expect(handler).toContain("export async function runSemanticSearchCommand");
    expect(handler).toContain("No stores found.");
    expect(handler).toContain("new GnosysSearch(storePath)");
    expect(handler).toContain("new GnosysEmbeddings(storePath)");
    expect(handler).toContain("new GnosysHybridSearch");
    expect(handler).toContain(
      'hybridSearch.hybridSearch(query, parseInt(opts.limit), "semantic")',
    );
    expect(handler).toContain("relativePath: r.relativePath");
    expect(handler).toContain(
      'No semantic results for "${query}". Run gnosys reindex first.',
    );
    expect(handler).toContain("search.close()");
    expect(handler).toContain("embeddings.close()");
    expect(handler).toContain('await import("./embeddings.js")');
    expect(handler).not.toContain('await import("./lib/embeddings.js")');
  });
});
