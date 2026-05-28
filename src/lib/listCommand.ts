import { GnosysDB } from "./db.js";
import { logError } from "./log.js";
import { findProjectIdentity } from "./projectIdentity.js";

export type ListCommandOptions = {
  category?: string;
  tag?: string;
  store?: string;
  json?: boolean;
  idFormat?: string;
};

function outputResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export async function runListCommand(opts: ListCommandOptions): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available. Run 'gnosys init' first.");
      process.exit(1);
    }

    const projIdentity = await findProjectIdentity(process.cwd());
    const projectId = projIdentity?.identity.projectId || null;

    let memories = centralDb.getActiveMemories();

    if (projectId) {
      memories = memories.filter(
        (m) => m.project_id === projectId || m.scope === "user" || m.scope === "global",
      );
    }

    if (opts.store) {
      memories = memories.filter((m) => m.scope === opts.store);
    }
    if (opts.category) {
      memories = memories.filter((m) => m.category === opts.category);
    }
    if (opts.tag) {
      memories = memories.filter((m) => {
        try {
          const tags: string[] = JSON.parse(m.tags || "[]");
          return tags.includes(opts.tag!);
        } catch {
          return false;
        }
      });
    }

    const { formatMemoryIdHyperlink: formatMemoryId, buildProjectNameLookup, parseIdFormat } =
      await import("./idFormat.js");
    const idFormat = parseIdFormat(opts.idFormat);
    const projectNames = buildProjectNameLookup(centralDb);

    outputResult(!!opts.json, {
      count: memories.length,
      memories: memories.map((m) => ({
        id: m.id,
        title: m.title,
        category: m.category,
        status: m.status,
        scope: m.scope,
        confidence: m.confidence,
        project: m.project_id ? projectNames.get(m.project_id) || null : null,
      })),
    }, () => {
      console.log(`${memories.length} memories:\n`);
      for (const m of memories) {
        const projectName = m.project_id ? projectNames.get(m.project_id) || null : null;
        const displayId = formatMemoryId(m.id, projectName, idFormat);
        console.log(`  [${m.scope}] [${m.status}] ${m.title}`);
        console.log(
          `    id: ${displayId} | category: ${m.category} | confidence: ${m.confidence}`,
        );
        console.log();
      }
    });
  } catch (err) {
    logError(err, { module: "cli", op: "list" });
    process.exit(1);
  } finally {
    centralDb?.close();
  }
}
