import type { GnosysDB } from "./db.js";

export type TraverseCommandOptions = {
  depth?: string;
  relTypes?: string;
  json?: boolean;
};

type TraverseNode = {
  id: string;
  title: string;
  confidence: number;
  depth: number;
  via_rel?: string;
  via_from?: string;
};

export async function runTraverseCommand(
  memoryId: string,
  opts: TraverseCommandOptions,
): Promise<void> {
  let db: GnosysDB | undefined;

  try {
    const { GnosysDB: GnosysDBClass } = await import("./db.js");
    const { handleRequest } = await import("../sandbox/server.js");

    const dbDir = GnosysDBClass.getCentralDbDir();
    db = new GnosysDBClass(dbDir);

    if (!db.isAvailable()) {
      console.error("Error: GnosysDB not available. Install it with: npm install better-sqlite3");
      process.exit(1);
    }

    const params: Record<string, unknown> = {
      id: memoryId,
      depth: opts.depth ? parseInt(opts.depth, 10) : 3,
    };
    if (opts.relTypes) params.rel_types = opts.relTypes.split(",").map((s) => s.trim());

    const res = handleRequest(db, {
      id: "cli-traverse",
      method: "traverse",
      params,
    });

    if (!res.ok) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: res.error }));
      } else {
        console.error(`Traverse failed: ${res.error}`);
      }
      process.exit(1);
    }

    const result = res.result as {
      depth: number;
      total: number;
      nodes: TraverseNode[];
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Traversal from ${memoryId} (depth: ${result.depth}):`);
      console.log(`  Total nodes: ${result.total}\n`);
      for (const node of result.nodes) {
        const indent = "  ".repeat(node.depth + 1);
        const via = node.via_rel ? ` ← [${node.via_rel}] from ${node.via_from}` : " (root)";
        console.log(`${indent}${node.id}: ${node.title} (conf: ${node.confidence.toFixed(2)})${via}`);
      }
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Traverse failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  } finally {
    db?.close();
  }
}
