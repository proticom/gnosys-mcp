import { GnosysDB } from "./db.js";

export type AmbiguityCommandOptions = {
  json: boolean;
};

export async function runAmbiguityCommand(
  query: string,
  opts: AmbiguityCommandOptions,
): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available.");
      process.exitCode = 1;
      return;
    }

    const { detectAmbiguity } = await import("./federated.js");
    const ambiguity = detectAmbiguity(centralDb, query);

    if (opts.json) {
      console.log(JSON.stringify({ query, ambiguous: !!ambiguity, ...(ambiguity || {}) }, null, 2));
    } else if (!ambiguity) {
      console.log(`No ambiguity for "${query}" — matches at most one project.`);
    } else {
      console.log(ambiguity.message);
      for (const c of ambiguity.candidates) {
        console.log(`\n  ${c.projectName} (${c.projectId})`);
        console.log(`    Dir: ${c.workingDirectory}`);
        console.log(`    Matching memories: ${c.memoryCount}`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}
