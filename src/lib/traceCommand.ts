import type { GnosysDB } from "./db.js";

export type TraceCommandOptions = {
  maxFiles?: string;
  projectId?: string;
  json?: boolean;
};

export async function runTraceCommand(
  directory: string,
  opts: TraceCommandOptions,
): Promise<void> {
  let db: GnosysDB | undefined;

  try {
    const { traceCodebase } = await import("./trace.js");
    const { GnosysDB: GnosysDBClass } = await import("./db.js");

    const dbDir = GnosysDBClass.getCentralDbDir();
    db = new GnosysDBClass(dbDir);

    if (!db.isAvailable()) {
      console.error("Error: GnosysDB not available. Install it with: npm install better-sqlite3");
      process.exit(1);
    }

    const result = traceCodebase(db, directory, {
      projectId: opts.projectId,
      maxFiles: opts.maxFiles ? parseInt(opts.maxFiles, 10) : undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Trace complete:`);
      console.log(`  Files scanned:        ${result.filesScanned}`);
      console.log(`  Functions found:       ${result.functionsFound}`);
      console.log(`  Memories created:      ${result.memoriesCreated}`);
      console.log(`  Relationships created: ${result.relationshipsCreated}`);
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Trace failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  } finally {
    db?.close();
  }
}
