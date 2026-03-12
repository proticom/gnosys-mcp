/**
 * Gnosys Migrate — Moves data from v1.x (Markdown + archive.db + embeddings.db)
 * into the unified gnosys.db (v2.0).
 *
 * Safe: original .md files and old DBs are untouched.
 * Reversible: delete gnosys.db to revert.
 */

import path from "path";
import { GnosysDB, fnv1a, MigrationStats } from "./db.js";
import { GnosysStore, Memory } from "./store.js";
import { GnosysArchive } from "./archive.js";

// Dynamic import for embeddings DB
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  // Not available
}

/**
 * Extract [[wikilinks]] from markdown content.
 * Returns array of link targets (the text inside double brackets).
 */
function extractWikilinks(content: string): string[] {
  const re = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = re.exec(content)) !== null) {
    links.push(match[1]);
  }
  return links;
}

/**
 * Resolve a wikilink target to a memory ID using fuzzy title matching.
 */
function resolveWikilink(target: string, titleMap: Map<string, string>): string | null {
  // Exact match on title
  const lower = target.toLowerCase().replace(/\.md$/, "");
  for (const [title, id] of titleMap) {
    if (title.toLowerCase() === lower) return id;
  }
  // Partial match
  for (const [title, id] of titleMap) {
    if (title.toLowerCase().includes(lower) || lower.includes(title.toLowerCase())) return id;
  }
  return null;
}

/**
 * Migrate all data from v1.x format into gnosys.db.
 */
export async function migrate(
  storePath: string,
  options?: { verbose?: boolean }
): Promise<MigrationStats> {
  const log = options?.verbose ? console.log : () => {};
  const stats: MigrationStats = {
    memoriesMigrated: 0,
    archiveMigrated: 0,
    relationshipsCreated: 0,
    ftsBuild: false,
  };

  // 1. Open/create gnosys.db
  const db = new GnosysDB(storePath);
  if (!db.isAvailable()) {
    throw new Error("Cannot create gnosys.db — better-sqlite3 not available");
  }

  // 2. Read all active .md memories
  const store = new GnosysStore(storePath);
  await store.init();
  const memories = await store.getAllMemories();
  log(`Found ${memories.length} active memories to migrate`);

  // Build title→ID map for wikilink resolution
  const titleMap = new Map<string, string>();

  // 3. Insert active memories
  db.transaction(() => {
    for (const mem of memories) {
      const tags = Array.isArray(mem.frontmatter.tags)
        ? JSON.stringify(mem.frontmatter.tags)
        : JSON.stringify(Object.values(mem.frontmatter.tags).flat());

      const contentHash = fnv1a(mem.content);

      db.insertMemory({
        id: mem.frontmatter.id,
        title: mem.frontmatter.title,
        category: mem.frontmatter.category,
        content: mem.content,
        summary: null,
        tags,
        relevance: (mem.frontmatter.relevance as string) || "",
        author: mem.frontmatter.author || "ai",
        authority: mem.frontmatter.authority || "imported",
        confidence: mem.frontmatter.confidence ?? 0.8,
        reinforcement_count: (mem.frontmatter as Record<string, unknown>).reinforcement_count as number || 0,
        content_hash: contentHash,
        status: mem.frontmatter.status || "active",
        tier: "active",
        supersedes: (mem.frontmatter.supersedes as string) || null,
        superseded_by: (mem.frontmatter.superseded_by as string) || null,
        last_reinforced: (mem.frontmatter as Record<string, unknown>).last_reinforced as string || null,
        created: mem.frontmatter.created,
        modified: mem.frontmatter.modified,
        embedding: null,
        source_path: mem.relativePath,
        project_id: null,
        scope: "project",
      });

      titleMap.set(mem.frontmatter.title, mem.frontmatter.id);
      stats.memoriesMigrated++;
    }
  });
  log(`Migrated ${stats.memoriesMigrated} active memories`);

  // 4. Migrate archive.db entries
  try {
    const archive = new GnosysArchive(storePath);
    if (archive.isAvailable()) {
      const archiveIds = archive.getAllArchivedIds();
      log(`Found ${archiveIds.length} archived memories to migrate`);

      db.transaction(() => {
        for (const archiveId of archiveIds) {
          const row = archive.getArchivedMemory(archiveId);
          if (!row) continue;

          // Parse stored frontmatter
          let frontmatter: Record<string, unknown> = {};
          try {
            frontmatter = JSON.parse(row.yaml_frontmatter);
          } catch {
            // Use minimal fields from row
          }

          const contentHash = fnv1a(row.content);

          db.insertMemory({
            id: row.id,
            title: row.title,
            category: row.category,
            content: row.content,
            summary: null,
            tags: row.tags ? JSON.stringify(row.tags.split(" ").filter(Boolean)) : "[]",
            relevance: (frontmatter.relevance as string) || row.tags || "",
            author: (frontmatter.author as string) || "ai",
            authority: (frontmatter.authority as string) || "imported",
            confidence: row.confidence ?? 0.8,
            reinforcement_count: (frontmatter.reinforcement_count as number) || 0,
            content_hash: contentHash,
            status: "archived",
            tier: "archive",
            supersedes: (frontmatter.supersedes as string) || null,
            superseded_by: (frontmatter.superseded_by as string) || null,
            last_reinforced: row.last_reinforced || null,
            created: (frontmatter.created as string) || row.archived_date,
            modified: (frontmatter.modified as string) || row.archived_date,
            embedding: null,
            source_path: row.original_path,
            project_id: null,
            scope: "project",
          });

          titleMap.set(row.title, row.id);
          stats.archiveMigrated++;
        }
      });
      archive.close();
      log(`Migrated ${stats.archiveMigrated} archived memories`);
    }
  } catch {
    log("No archive.db found or archive migration skipped");
  }

  // 5. Copy embeddings from embeddings.db
  try {
    const embPath = path.join(storePath, ".config", "embeddings.db");
    if (Database) {
      const embDb = new Database(embPath, { readonly: true });
      const rows = embDb.prepare("SELECT file_path, embedding FROM embeddings").all() as Array<{
        file_path: string;
        embedding: Buffer;
      }>;

      let embCount = 0;
      for (const row of rows) {
        // file_path might be "category/file.md" — we need to find the matching memory
        const matchingMemory = memories.find((m) => m.relativePath === row.file_path);
        if (matchingMemory) {
          db.updateEmbedding(matchingMemory.frontmatter.id, row.embedding);
          embCount++;
        }
      }
      embDb.close();
      log(`Copied ${embCount} embeddings`);
    }
  } catch {
    log("No embeddings.db found or embedding copy skipped");
  }

  // 6. Build relationships from wikilinks
  const today = new Date().toISOString().split("T")[0];
  db.transaction(() => {
    for (const mem of memories) {
      const links = extractWikilinks(mem.content);
      for (const link of links) {
        const targetId = resolveWikilink(link, titleMap);
        if (targetId && targetId !== mem.frontmatter.id) {
          db.insertRelationship({
            source_id: mem.frontmatter.id,
            target_id: targetId,
            rel_type: "references",
            label: link,
            confidence: 1.0,
            created: today,
          });
          stats.relationshipsCreated++;
        }
      }

      // Build supersedes relationships
      if (mem.frontmatter.supersedes) {
        const supersedesIds = (mem.frontmatter.supersedes as string).split(",").map((s) => s.trim());
        for (const sid of supersedesIds) {
          if (sid) {
            db.insertRelationship({
              source_id: mem.frontmatter.id,
              target_id: sid,
              rel_type: "supersedes",
              label: null,
              confidence: 1.0,
              created: today,
            });
            stats.relationshipsCreated++;
          }
        }
      }
    }
  });
  log(`Created ${stats.relationshipsCreated} relationships`);

  // 7. Log migration in audit
  db.logAudit({
    timestamp: new Date().toISOString(),
    operation: "migrate",
    memory_id: null,
    details: JSON.stringify(stats),
    duration_ms: null,
    trace_id: null,
  });

  stats.ftsBuild = true;
  db.close();

  return stats;
}

/**
 * Format migration results for CLI output.
 */
export function formatMigrationReport(stats: MigrationStats): string {
  const lines = [
    "╔════════════════════════════════════════╗",
    "║     Gnosys Migration Complete          ║",
    "╚════════════════════════════════════════╝",
    "",
    `  Active memories migrated:   ${stats.memoriesMigrated}`,
    `  Archived memories migrated: ${stats.archiveMigrated}`,
    `  Relationships created:      ${stats.relationshipsCreated}`,
    `  FTS5 index built:           ${stats.ftsBuild ? "✓" : "✗"}`,
    "",
    "  Original .md files and archive.db are untouched.",
    "  Delete gnosys.db to revert to v1.x format.",
  ];
  return lines.join("\n");
}
