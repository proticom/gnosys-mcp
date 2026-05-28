import { GnosysDB } from "./db.js";

export type WorkingSetCommandOptions = {
  directory?: string;
  window: string;
  json: boolean;
};

export async function runWorkingSetCommand(
  opts: WorkingSetCommandOptions,
): Promise<void> {
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }
  
        const { getWorkingSet, formatWorkingSet, detectCurrentProject } = await import("./federated.js");
        const pid = await detectCurrentProject(centralDb, opts.directory || undefined);
        if (!pid) { console.error("No project detected."); process.exit(1); }
  
        const windowHours = parseInt(opts.window, 10);
        const workingSet = getWorkingSet(centralDb, pid, { windowHours });
  
        if (opts.json) {
          console.log(JSON.stringify({
            projectId: pid,
            windowHours,
            count: workingSet.length,
            memories: workingSet.map((m) => ({ id: m.id, title: m.title, category: m.category, modified: m.modified })),
          }, null, 2));
        } else {
          console.log(formatWorkingSet(workingSet));
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        centralDb?.close();
      }
}
