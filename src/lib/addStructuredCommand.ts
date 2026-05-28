import { GnosysDB } from "./db.js";

export type AddStructuredOptions = {
  title: string;
  category: string;
  content: string;
  tags: string;
  relevance: string;
  author: string;
  authority: string;
  confidence: string;
  store?: string;
  user?: boolean;
  global?: boolean;
};

type ResolveProjectId = (dir?: string) => Promise<string | null>;

export async function runAddStructuredCommand(
  opts: AddStructuredOptions,
  resolveProjectId: ResolveProjectId,
): Promise<void> {
        // ─── Phase 9b: --user / --global route through central DB ─────
        if (opts.user || opts.global) {
          let centralDb: GnosysDB | null = null;
          try {
            centralDb = GnosysDB.openCentral();
            if (!centralDb.isAvailable()) {
              console.error("Central DB not available.");
              process.exit(1);
            }
            const scope = opts.global ? "global" : "user";
            const now = new Date().toISOString();
            const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const projectId = opts.global ? null : await resolveProjectId();
  
            centralDb.insertMemory({
              id,
              title: opts.title,
              category: opts.category,
              content: `# ${opts.title}\n\n${opts.content}`,
              summary: null,
              tags: opts.tags,
              relevance: opts.relevance || opts.content.slice(0, 200),
              author: opts.author,
              authority: opts.authority,
              confidence: parseFloat(opts.confidence),
              reinforcement_count: 0,
              content_hash: "",
              status: "active",
              tier: "active",
              supersedes: null,
              superseded_by: null,
              last_reinforced: null,
              created: now,
              modified: now,
              embedding: null,
              source_path: null,
              project_id: projectId,
              scope,
            });
  
            console.log(`Memory added (scope: ${scope}): ${opts.title}`);
            console.log(`ID: ${id}`);
            return;
          } catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : err}`);
            process.exit(1);
          } finally {
            centralDb?.close();
          }
        }
  
        // ─── DB-only write ────────────────────────────────────────────
        let tags: Record<string, string[]>;
        try {
          tags = JSON.parse(opts.tags);
        } catch {
          console.error("Invalid --tags JSON. Example: '{\"domain\":[\"auth\"],\"type\":[\"decision\"]}'");
          process.exit(1);
        }
  
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          const projectId = await resolveProjectId();
          const id = centralDb.getNextId(opts.category, projectId || undefined);
          const now = new Date().toISOString();
          const content = `# ${opts.title}\n\n${opts.content}`;
  
          const tagsJson = Array.isArray(tags)
            ? JSON.stringify(tags)
            : JSON.stringify(Object.values(tags).flat());
  
          centralDb.insertMemory({
            id,
            title: opts.title,
            category: opts.category,
            content,
            summary: null,
            tags: tagsJson,
            relevance: opts.relevance || opts.content.slice(0, 200),
            author: opts.author,
            authority: opts.authority,
            confidence: parseFloat(opts.confidence),
            reinforcement_count: 0,
            content_hash: "",
            status: "active",
            tier: "active",
            supersedes: null,
            superseded_by: null,
            last_reinforced: null,
            created: now,
            modified: now,
            embedding: null,
            source_path: null,
            project_id: projectId,
            scope: "project",
          });
  
          console.log(`Memory added: ${opts.title}`);
          console.log(`ID: ${id}`);
        } finally {
          centralDb?.close();
        }
}
