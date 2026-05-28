import { GnosysDB } from "./db.js";
import type { GnosysResolver } from "./resolver.js";

export type UpdateCommandOptions = {
  title?: string;
  status?: string;
  confidence?: string;
  relevance?: string;
  supersedes?: string;
  supersededBy?: string;
  content?: string;
};

type GetResolver = () => Promise<GnosysResolver>;

export async function runUpdateCommand(
  getResolver: GetResolver,
  memoryPath: string,
  opts: UpdateCommandOptions,
): Promise<void> {
  let memoryId: string;
  let currentTitle: string;

  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
  } catch {
    /* handled below */
  }

  if (centralDb?.isAvailable()) {
    const dbMem = centralDb.getMemory(memoryPath);
    if (dbMem) {
      memoryId = dbMem.id;
      currentTitle = dbMem.title;
    } else {
      const resolver = await getResolver();
      const memory = await resolver.readMemory(memoryPath);
      if (!memory || !memory.frontmatter.id) {
        console.error(`Memory not found: ${memoryPath}`);
        centralDb?.close();
        process.exit(1);
      }
      memoryId = memory.frontmatter.id;
      currentTitle = memory.frontmatter.title || memoryPath;
    }
  } else {
    console.error("Central DB not available.");
    process.exit(1);
  }

  const updates: Record<string, unknown> = {};
  if (opts.title !== undefined) updates.title = opts.title;
  if (opts.status !== undefined) updates.status = opts.status;
  if (opts.confidence !== undefined) updates.confidence = parseFloat(opts.confidence);
  if (opts.relevance !== undefined) updates.relevance = opts.relevance;
  if (opts.supersedes !== undefined) updates.supersedes = opts.supersedes;
  if (opts.supersededBy !== undefined) updates.superseded_by = opts.supersededBy;

  const fullContent = opts.content
    ? `# ${opts.title || currentTitle}\n\n${opts.content}`
    : undefined;

  try {
    const { syncUpdateToDb } = await import("./dbWrite.js");
    syncUpdateToDb(centralDb, memoryId, updates as Parameters<typeof syncUpdateToDb>[2], fullContent);

    if (opts.supersedes) {
      syncUpdateToDb(
        centralDb,
        opts.supersedes,
        { superseded_by: memoryId, status: "superseded" } as Parameters<typeof syncUpdateToDb>[2],
      );
      console.log(`Cross-linked: ${opts.supersedes} marked as superseded.`);
    }
  } finally {
    centralDb?.close();
  }

  const changedFields = Object.keys(updates);
  if (opts.content) changedFields.push("content");

  console.log(`Memory updated: ${opts.title || currentTitle}`);
  console.log(`ID: ${memoryId}`);
  console.log(`Changed: ${changedFields.join(", ")}`);
}
