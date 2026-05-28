import fs from "fs/promises";
import path from "path";
import { GnosysDB } from "./db.js";
import type { GnosysResolver } from "./resolver.js";

export type ReinforceCommandOptions = {
  signal: string;
  context?: string;
};

type GetResolver = () => Promise<GnosysResolver>;

export async function runReinforceCommand(
  getResolver: GetResolver,
  memoryId: string,
  opts: ReinforceCommandOptions,
): Promise<void> {
  const resolver = await getResolver();
  const writeTarget = resolver.getWriteTarget();
  if (!writeTarget) {
    console.error("No writable store found.");
    process.exit(1);
  }

  const logDir = path.join(writeTarget.store.getStorePath(), ".config");
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, "reinforcement.log");
  const entry = JSON.stringify({
    memory_id: memoryId,
    signal: opts.signal,
    context: opts.context,
    timestamp: new Date().toISOString(),
  });
  await fs.appendFile(logPath, entry + "\n", "utf-8");

  if (opts.signal === "useful") {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      const { syncUpdateToDb } = await import("./dbWrite.js");
      syncUpdateToDb(centralDb, memoryId, {
        modified: new Date().toISOString().split("T")[0],
      } as Parameters<typeof syncUpdateToDb>[2]);
    } finally {
      centralDb?.close();
    }
  }

  const messages: Record<string, string> = {
    useful: `Memory ${memoryId} reinforced. Decay clock reset.`,
    not_relevant: `Routing feedback logged for ${memoryId}. Memory unchanged.`,
    outdated: `Memory ${memoryId} flagged for review as outdated.`,
  };
  console.log(messages[opts.signal] || `Signal '${opts.signal}' logged for ${memoryId}.`);
}
