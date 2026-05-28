import { GnosysDB } from "./db.js";
import type { AuditOperation } from "./audit.js";

export type AuditCommandOptions = {
  days: string;
  operation?: string;
  limit?: string;
  json?: boolean;
};

export async function runAuditCommand(opts: AuditCommandOptions): Promise<void> {
  const { readAuditFromDb, formatAuditTimeline } = await import("./audit.js");

  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB unavailable.");
      process.exitCode = 1;
      return;
    }

    const entries = readAuditFromDb(centralDb, {
      days: parseInt(opts.days, 10),
      operation: opts.operation as AuditOperation | undefined,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log(formatAuditTimeline(entries));
    }
  } finally {
    centralDb?.close();
  }
}
