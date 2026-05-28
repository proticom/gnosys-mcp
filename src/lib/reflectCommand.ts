import type { GnosysDB } from "./db.js";

export type ReflectCommandOptions = {
  memoryIds?: string;
  failure?: boolean;
  notes?: string;
  confidenceDelta?: string;
  json?: boolean;
};

export async function runReflectCommand(
  outcome: string,
  opts: ReflectCommandOptions,
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
      outcome,
      success: !opts.failure,
    };
    if (opts.memoryIds) params.memory_ids = opts.memoryIds.split(",").map((s) => s.trim());
    if (opts.notes) params.notes = opts.notes;
    if (opts.confidenceDelta) params.confidence_delta = parseFloat(opts.confidenceDelta);

    const res = handleRequest(db, {
      id: "cli-reflect",
      method: "reflect",
      params,
    });

    if (!res.ok) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: res.error }));
      } else {
        console.error(`Reflect failed: ${res.error}`);
      }
      process.exit(1);
    }

    const result = res.result as {
      reflection_id: string;
      outcome: string;
      memories_updated: unknown[];
      relationships_created: number;
      confidence_delta: number;
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Reflection recorded:`);
      console.log(`  ID:                    ${result.reflection_id}`);
      console.log(`  Outcome:               ${result.outcome}`);
      console.log(`  Memories updated:      ${result.memories_updated.length}`);
      console.log(`  Relationships created: ${result.relationships_created}`);
      console.log(`  Confidence delta:      ${result.confidence_delta > 0 ? "+" : ""}${result.confidence_delta.toFixed(2)}`);
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Reflect failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  } finally {
    db?.close();
  }
}
