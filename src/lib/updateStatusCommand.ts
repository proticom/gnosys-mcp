import { GnosysDB } from "./db.js";

export type UpdateStatusCommandOptions = {
  directory?: string;
  project?: string;
};

export async function runUpdateStatusCommand(
  opts: UpdateStatusCommandOptions,
): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available.");
      process.exitCode = 1;
      return;
    }

    const { detectCurrentProject } = await import("./federated.js");
    const { generateStatusPrompt } = await import("./portfolio.js");

    let pid = opts.project || null;
    if (!pid) pid = await detectCurrentProject(centralDb, opts.directory || undefined);
    if (!pid) {
      console.error("No project specified and none detected.");
      process.exitCode = 1;
      return;
    }

    const project = centralDb.getProject(pid);
    if (!project) {
      console.error(`Project not found: ${pid}`);
      process.exitCode = 1;
      return;
    }

    const prompt = generateStatusPrompt(project.name, project.working_directory);
    console.log(prompt);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}
