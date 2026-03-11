/**
 * Gnosys Recall — Ultra-fast memory recall for enterprise agent orchestrators.
 *
 * The outer system calls gnosys_recall before every agent turn to inject
 * the most relevant memories into context. Designed for sub-50ms response
 * on typical vaults (< 5000 active memories).
 *
 * Pipeline: FTS5 keyword search (fastest) → optional archive fallback → format
 * No LLM calls. No embeddings. Pure index lookup.
 */

import { GnosysSearch } from "./search.js";
import { GnosysResolver } from "./resolver.js";
import { GnosysArchive } from "./archive.js";
import { auditLog } from "./audit.js";

export interface RecallResult {
  memories: RecallMemory[];
  totalActive: number;
  totalArchived: number;
  recallTimeMs: number;
}

export interface RecallMemory {
  id: string;
  title: string;
  category: string;
  relevance: string;
  confidence: number;
  path: string;
  fromArchive: boolean;
  snippet: string;
}

/**
 * Fast recall — keyword search only, no LLM, no embeddings.
 * Designed to be called before every agent turn (sub-50ms target).
 */
export async function recall(
  query: string,
  options: {
    limit?: number;
    search: GnosysSearch;
    resolver: GnosysResolver;
    storePath: string;
    traceId?: string;
  }
): Promise<RecallResult> {
  const start = performance.now();
  const limit = options.limit || 8;
  const memories: RecallMemory[] = [];

  // Step 1: Fast keyword search on active memories (FTS5 — sub-10ms)
  const activeResults = options.search.discover(query, limit);

  for (const r of activeResults) {
    // Load frontmatter for metadata
    const memory = await options.resolver.readMemory(r.relative_path);
    if (memory) {
      memories.push({
        id: memory.frontmatter.id,
        title: memory.frontmatter.title,
        category: memory.frontmatter.category,
        relevance: memory.frontmatter.relevance || "",
        confidence: memory.frontmatter.confidence,
        path: r.relative_path,
        fromArchive: false,
        snippet: memory.content.substring(0, 200),
      });
    }
  }

  // Step 2: If active results insufficient, search archive (still fast — FTS5)
  let totalArchived = 0;
  if (memories.length < limit) {
    try {
      const archive = new GnosysArchive(options.storePath);
      if (archive.isAvailable()) {
        const stats = archive.getStats();
        totalArchived = stats.totalArchived;

        const archiveResults = archive.searchArchive(query, limit - memories.length);
        const existingTitles = new Set(memories.map((m) => m.title.toLowerCase()));

        for (const ar of archiveResults) {
          if (!existingTitles.has(ar.title.toLowerCase())) {
            memories.push({
              id: ar.id,
              title: ar.title,
              category: ar.category,
              relevance: ar.tags,
              confidence: 0, // archived — confidence was low
              path: `archive:${ar.category}/${ar.id}`,
              fromArchive: true,
              snippet: ar.snippet,
            });
          }
        }
        archive.close();
      }
    } catch {
      // Archive not available — degrade gracefully
    }
  }

  const elapsed = performance.now() - start;

  // Audit log
  auditLog({
    operation: "recall",
    query,
    resultCount: memories.length,
    durationMs: elapsed,
    traceId: options.traceId,
  });

  return {
    memories: memories.slice(0, limit),
    totalActive: activeResults.length,
    totalArchived,
    recallTimeMs: Math.round(elapsed * 100) / 100,
  };
}

/**
 * Format recall results as a concise context block for agent injection.
 */
export function formatRecall(result: RecallResult): string {
  if (result.memories.length === 0) {
    return `[Gnosys Recall] No relevant memories found. (${result.recallTimeMs}ms)`;
  }

  const lines: string[] = [
    `[Gnosys Recall] ${result.memories.length} memories (${result.recallTimeMs}ms)`,
    "",
  ];

  for (const m of result.memories) {
    const archive = m.fromArchive ? " [ARCHIVED]" : "";
    lines.push(`• ${m.title}${archive}`);
    lines.push(`  Category: ${m.category} | Confidence: ${m.confidence}`);
    lines.push(`  Path: ${m.path}`);
    if (m.snippet) {
      lines.push(`  ${m.snippet.substring(0, 150).replace(/\n/g, " ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
