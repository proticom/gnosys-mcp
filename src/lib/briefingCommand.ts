import { GnosysDB } from "./db.js";

export type BriefingCommandOptions = {
  project?: string;
  all?: boolean;
  directory?: string;
  json: boolean;
};

export async function runBriefingCommand(
  projectNameOrId: string | undefined,
  opts: BriefingCommandOptions,
): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available.");
      process.exitCode = 1;
      return;
    }

    const { generateBriefing, generateAllBriefings, detectCurrentProject } =
      await import("./federated.js");

    if (opts.all) {
      const briefings = generateAllBriefings(centralDb);
      if (opts.json) {
        console.log(JSON.stringify({ count: briefings.length, briefings }, null, 2));
      } else {
        if (briefings.length === 0) {
          console.log("No projects registered.");
          return;
        }
        for (const b of briefings) {
          console.log(`\n## ${b.projectName}`);
          console.log(b.summary);
        }
      }
      return;
    }

    // v5.7.0: accept project name as positional argument in addition to --project <id>.
    // Resolution order: positional name → --project flag → cwd auto-detect.
    let pid = opts.project ?? null;
    if (!pid && projectNameOrId) {
      const byId = centralDb.getProject(projectNameOrId);
      if (byId) {
        pid = byId.id;
      } else {
        const all = centralDb.getAllProjects();
        const byName = all.find((p) => p.name === projectNameOrId);
        if (byName) pid = byName.id;
      }
      if (!pid) {
        console.error(
          `Project not found: "${projectNameOrId}". Run 'gnosys projects' to list registered projects.`,
        );
        process.exitCode = 1;
        return;
      }
    }
    if (!pid) pid = await detectCurrentProject(centralDb, opts.directory || undefined);
    if (!pid) {
      console.error("No project specified and none detected.");
      process.exitCode = 1;
      return;
    }

    const briefing = generateBriefing(centralDb, pid);
    if (!briefing) {
      console.error(`Project not found: ${pid}`);
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(briefing, null, 2));
    } else {
      console.log(`# Briefing: ${briefing.projectName}`);
      console.log(`Directory: ${briefing.workingDirectory}`);
      console.log(`Active memories: ${briefing.activeMemories} / ${briefing.totalMemories}`);
      console.log(`\nCategories:`);
      for (const [cat, count] of Object.entries(briefing.categories).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${cat}: ${count}`);
      }
      console.log(`\nRecent activity (7d):`);
      if (briefing.recentActivity.length === 0) {
        console.log("  None");
      }
      for (const r of briefing.recentActivity) {
        console.log(`  - ${r.title} (${r.modified})`);
      }
      console.log(
        `\nTop tags: ${briefing.topTags.slice(0, 10).map((t) => `${t.tag}(${t.count})`).join(", ") || "None"}`,
      );
      console.log(`\n${briefing.summary}`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}
