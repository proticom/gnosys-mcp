import { GnosysDB } from "./db.js";
import { groupDbByPeriod, type TimePeriod } from "./timeline.js";

export type TimelineCommandOptions = {
  period: string;
  project?: string;
  limitTitles: string;
  json?: boolean;
};

function outputResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export async function runTimelineCommand(opts: TimelineCommandOptions): Promise<void> {
  const centralDb = GnosysDB.openCentral();
  if (!centralDb.isAvailable()) {
    console.error("Central DB unavailable.");
    process.exit(1);
  }
  try {
    const memories = opts.project
      ? centralDb.getMemoriesByProject(opts.project)
      : centralDb.getActiveMemories();

    if (memories.length === 0) {
      outputResult(!!opts.json, { period: opts.period, count: 0, entries: [] }, () => {
        console.log("No memories found.");
      });
      return;
    }

    const entries = groupDbByPeriod(memories, opts.period as TimePeriod);
    const titleLimit = Math.max(0, parseInt(opts.limitTitles, 10) || 5);

    outputResult(!!opts.json, { period: opts.period, count: memories.length, entries }, () => {
      console.log(`Knowledge Timeline (by ${opts.period}, ${memories.length} memories):\n`);
      for (const entry of entries) {
        const parts = [];
        if (entry.created > 0) parts.push(`${entry.created} created`);
        if (entry.modified > 0) parts.push(`${entry.modified} modified`);
        console.log(`  ${entry.period}: ${parts.join(", ")}`);
        if (entry.titles.length > 0 && entry.titles.length <= titleLimit) {
          for (const t of entry.titles) {
            console.log(`    + ${t}`);
          }
        }
      }
    });
  } finally {
    centralDb.close();
  }
}
