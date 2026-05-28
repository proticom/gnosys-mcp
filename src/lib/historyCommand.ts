import { GnosysDB } from "./db.js";

export type HistoryCommandOptions = {
  limit: string;
  json?: boolean;
};

function outputResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export async function runHistoryCommand(
  memoryPath: string,
  opts: HistoryCommandOptions,
): Promise<void> {
  const centralDb = GnosysDB.openCentral();
  if (!centralDb.isAvailable()) {
    console.error("Central DB not available.");
    process.exit(1);
  }
  try {
    const dbMem = centralDb.getMemory(memoryPath);
    if (!dbMem) {
      console.error(`Memory not found: ${memoryPath}`);
      process.exit(1);
    }

    const limit = parseInt(opts.limit, 10) || 20;
    const audits = centralDb.getAuditLog(dbMem.id, limit);

    outputResult(!!opts.json, {
      memoryId: dbMem.id,
      title: dbMem.title,
      created: dbMem.created,
      modified: dbMem.modified,
      entries: audits,
    }, () => {
      if (audits.length === 0) {
        console.log(`Memory: ${dbMem.title} (${dbMem.id})`);
        console.log(`Created: ${dbMem.created}`);
        console.log(`Modified: ${dbMem.modified}`);
        console.log("No audit history recorded.");
        return;
      }

      console.log(`History for ${dbMem.title} (${dbMem.id}, ${audits.length} entries):\n`);
      console.log(`Created: ${dbMem.created}`);
      console.log(`Modified: ${dbMem.modified}\n`);
      for (const entry of audits) {
        const date = entry.timestamp.split("T")[0];
        const detail = entry.details ? ` (${entry.details})` : "";
        console.log(`  ${date}  ${entry.operation}${detail}`);
      }
    });
  } finally {
    centralDb.close();
  }
}
