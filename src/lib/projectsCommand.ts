import { existsSync } from "fs";
import { GnosysDB } from "./db.js";

export type ProjectsCommandOptions = {
  json?: boolean;
  all?: boolean;
  prune?: boolean;
  dryRun?: boolean;
  yes?: boolean;
};

function isDeadProjectDir(dir: string): boolean {
  return !existsSync(dir);
}

function outputProjectsResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export async function runProjectsCommand(opts: ProjectsCommandOptions): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available (better-sqlite3 missing).");
      process.exitCode = 1;
      return;
    }

    const allProjects = centralDb.getAllProjects();

    const { readMachineConfig } = await import("./machineConfig.js");
    const { effectiveProjectPath } = await import("./projectPaths.js");
    const machine = readMachineConfig();
    const resolvedDirOf = (p: typeof allProjects[number]): string | null =>
      effectiveProjectPath(centralDb!, p, machine);
    const isNotHere = (p: typeof allProjects[number]): boolean => {
      const ep = resolvedDirOf(p);
      return ep === null || !existsSync(ep);
    };

    if (opts.prune) {
      const deadProjects = allProjects.filter((p) => isDeadProjectDir(p.working_directory));

      if (deadProjects.length === 0) {
        console.log("No dead projects to prune.");
        return;
      }

      const DIM = "\x1b[2m";
      const RESET = "\x1b[0m";

      console.log(`Found ${deadProjects.length} dead project(s):\n`);
      for (const p of deadProjects) {
        const memCount = centralDb.getMemoriesByProject(p.id, true).length;
        console.log(`  ${p.name}  ${DIM}${p.working_directory}${RESET}  (${memCount} memorie(s))`);
      }
      console.log();

      if (opts.dryRun) {
        console.log("[dry-run] No changes made. Re-run without --dry-run to delete.");
        return;
      }

      if (!opts.yes) {
        const readline = await import("readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let answer = "";
        try {
          answer = (await rl.question(`Delete these ${deadProjects.length} project registry entries? [y/N] `)).trim().toLowerCase();
        } finally {
          rl.close();
        }
        if (answer !== "y" && answer !== "yes") {
          console.log("Cancelled.");
          return;
        }
      }

      for (const p of deadProjects) {
        centralDb.deleteProject(p.id);
      }

      outputProjectsResult(!!opts.json, {
        deleted: deadProjects.length,
        remaining: allProjects.length - deadProjects.length,
        deletedProjects: deadProjects.map((p) => ({ id: p.id, name: p.name, directory: p.working_directory })),
      }, () => {
        console.log(`✓ Pruned ${deadProjects.length} project(s). ${allProjects.length - deadProjects.length} remain.`);
      });
      return;
    }

    const visibleProjects = opts.all
      ? allProjects
      : allProjects.filter((p) => !isNotHere(p));

    if (visibleProjects.length === 0) {
      const deadCount = allProjects.length;
      outputProjectsResult(!!opts.json, {
        count: 0,
        totalRegistered: deadCount,
        deadCount,
        projects: [],
      }, () => {
        if (deadCount === 0) {
          console.log("No projects registered. Run 'gnosys init' in a project directory.");
        } else {
          console.log(`No live projects (${deadCount} dead — run 'gnosys projects --all' to see them or 'gnosys projects --prune' to remove them).`);
        }
      });
      return;
    }

    const projectData = visibleProjects.map((p) => ({
      ...p,
      resolvedDir: resolvedDirOf(p) ?? "(not on this machine)",
      memoryCount: centralDb!.getMemoriesByProject(p.id).length,
    }));

    const deadCount = allProjects.length - visibleProjects.length;

    outputProjectsResult(!!opts.json, {
      count: visibleProjects.length,
      totalRegistered: allProjects.length,
      deadCount,
      projects: projectData,
    }, () => {
      const header = deadCount > 0 && !opts.all
        ? `${visibleProjects.length} live project(s) (${deadCount} dead hidden — use --all or --prune):\n`
        : `${visibleProjects.length} registered project(s):\n`;
      console.log(header);
      for (const p of projectData) {
        console.log(`  ${p.name}`);
        console.log(`    ID:        ${p.id}`);
        console.log(`    Directory: ${p.resolvedDir}`);
        console.log(`    Memories:  ${p.memoryCount}`);
        console.log(`    Created:   ${p.created}`);
        console.log();
      }
    });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}
