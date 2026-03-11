/**
 * Gnosys Recall — Always-on automatic context injection for agent orchestrators.
 *
 * Designed to be called BEFORE every agent turn to inject the most relevant
 * memories into context. Sub-50ms response on typical vaults (< 5000 active).
 *
 * Pipeline: FTS5 keyword search (fastest) → relevance filtering → optional
 * archive fallback → format as host-friendly <gnosys-recall> block.
 *
 * Modes:
 *   aggressive (default): Always inject top N + any high-relevance memories
 *   balanced: Only inject if relevance > minRelevanceScore
 *   conservative: Only inject high-relevance memories (>0.8 normalized)
 *
 * No LLM calls. No embeddings. Pure index lookup.
 */

import { GnosysSearch, DiscoverResult } from "./search.js";
import { GnosysResolver } from "./resolver.js";
import { GnosysArchive } from "./archive.js";
import { auditLog } from "./audit.js";
import { RecallConfig } from "./config.js";

export interface RecallResult {
  memories: RecallMemory[];
  totalActive: number;
  totalArchived: number;
  recallTimeMs: number;
  mode: string;
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
  /** Normalized relevance score (0-1, higher = more relevant) */
  relevanceScore: number;
}

/** Default recall config (aggressive mode) */
const DEFAULT_RECALL_CONFIG: RecallConfig = {
  mode: "aggressive",
  minRelevanceScore: 0.65,
  maxMemoriesPerTurn: 8,
  alwaysInjectTopN: 3,
};

/**
 * Normalize FTS5 rank to a 0-1 relevance score.
 * FTS5 rank is negative (closer to 0 = more relevant).
 * We map it to 0-1 where 1 = most relevant.
 */
function normalizeRank(rank: number, allRanks: number[]): number {
  if (allRanks.length === 0) return 0.5;
  if (allRanks.length === 1) return 0.9; // Single result is probably relevant

  const minRank = Math.min(...allRanks); // Most relevant (most negative)
  const maxRank = Math.max(...allRanks); // Least relevant (least negative / closest to 0)

  if (maxRank === minRank) return 0.9; // All same rank

  // Linear normalization: most negative rank → 1.0, least negative → 0.3
  return 0.3 + 0.7 * ((maxRank - rank) / (maxRank - minRank));
}

/**
 * Fast recall — keyword search only, no LLM, no embeddings.
 * Designed to be called before every agent turn (sub-50ms target).
 *
 * In aggressive mode (default), always returns at least `alwaysInjectTopN`
 * memories even if relevance is moderate. In balanced mode, applies a
 * relevance threshold. In conservative mode, only returns high-relevance hits.
 */
export async function recall(
  query: string,
  options: {
    limit?: number;
    search: GnosysSearch;
    resolver: GnosysResolver;
    storePath: string;
    traceId?: string;
    recallConfig?: RecallConfig;
  }
): Promise<RecallResult> {
  const start = performance.now();
  const cfg = options.recallConfig || DEFAULT_RECALL_CONFIG;
  const limit = options.limit || cfg.maxMemoriesPerTurn;
  const memories: RecallMemory[] = [];

  // Step 1: Fast keyword search on active memories (FTS5 — sub-10ms)
  // Fetch extra results so we can filter by relevance
  const fetchLimit = Math.max(limit * 2, 15);
  const activeResults = options.search.discover(query, fetchLimit);
  const allRanks = activeResults.map((r) => r.rank);

  for (const r of activeResults) {
    const memory = await options.resolver.readMemory(r.relative_path);
    if (memory) {
      const relevanceScore = normalizeRank(r.rank, allRanks);
      memories.push({
        id: memory.frontmatter.id,
        title: memory.frontmatter.title,
        category: memory.frontmatter.category,
        relevance: memory.frontmatter.relevance || "",
        confidence: memory.frontmatter.confidence,
        path: r.relative_path,
        fromArchive: false,
        snippet: memory.content.substring(0, 300),
        relevanceScore,
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
              confidence: 0,
              path: `archive:${ar.category}/${ar.id}`,
              fromArchive: true,
              snippet: ar.snippet,
              relevanceScore: 0.5, // Archive results get moderate default relevance
            });
          }
        }
        archive.close();
      }
    } catch {
      // Archive not available — degrade gracefully
    }
  }

  // Step 3: Apply relevance filtering based on mode
  const filtered = applyModeFilter(memories, cfg, limit);

  const elapsed = performance.now() - start;

  auditLog({
    operation: "recall",
    query,
    resultCount: filtered.length,
    durationMs: elapsed,
    traceId: options.traceId,
    details: {
      mode: cfg.mode,
      totalCandidates: memories.length,
      filtered: filtered.length,
    },
  });

  return {
    memories: filtered,
    totalActive: activeResults.length,
    totalArchived,
    recallTimeMs: Math.round(elapsed * 100) / 100,
    mode: cfg.mode,
  };
}

/**
 * Apply mode-based filtering to candidate memories.
 */
function applyModeFilter(
  memories: RecallMemory[],
  cfg: RecallConfig,
  limit: number
): RecallMemory[] {
  // Sort by relevance score (highest first)
  const sorted = [...memories].sort((a, b) => b.relevanceScore - a.relevanceScore);

  switch (cfg.mode) {
    case "aggressive": {
      // Always inject at least the top N + any additional high-relevance ones
      const topN = sorted.slice(0, cfg.alwaysInjectTopN);
      const remaining = sorted.slice(cfg.alwaysInjectTopN);
      const highRelevance = remaining.filter((m) => m.relevanceScore >= cfg.minRelevanceScore);
      const combined = [...topN, ...highRelevance];
      return combined.slice(0, limit);
    }

    case "balanced": {
      // Only include memories above the relevance threshold
      const filtered = sorted.filter((m) => m.relevanceScore >= cfg.minRelevanceScore);
      return filtered.slice(0, limit);
    }

    case "conservative": {
      // Only high-relevance memories (>0.8)
      const filtered = sorted.filter((m) => m.relevanceScore >= 0.8);
      return filtered.slice(0, limit);
    }

    default:
      return sorted.slice(0, limit);
  }
}

/**
 * Format recall results as a host-friendly <gnosys-recall> block.
 * This is the format injected into agent context on every turn.
 *
 * When no strong memories exist, returns a lightweight marker so the
 * host knows the recall system is active and working.
 */
export function formatRecall(result: RecallResult): string {
  if (result.memories.length === 0) {
    return `<gnosys: no-strong-recall-needed>`;
  }

  const lines: string[] = [`<gnosys-recall>`];

  for (let i = 0; i < result.memories.length; i++) {
    const m = result.memories[i];
    const archive = m.fromArchive ? " [ARCHIVED]" : "";
    const filename = m.path.split("/").pop() || m.path;
    lines.push(`[Memory ${i + 1}] [[${filename}]] (relevance: ${m.relevanceScore.toFixed(2)})${archive}`);
    if (m.snippet) {
      lines.push(m.snippet.substring(0, 250).replace(/\n/g, " ").trim());
    }
    lines.push("");
  }

  lines.push(`</gnosys-recall>`);
  return lines.join("\n");
}

/**
 * Format recall results as a concise CLI-friendly output.
 */
export function formatRecallCLI(result: RecallResult): string {
  if (result.memories.length === 0) {
    return `[Gnosys Recall] No relevant memories found. (mode: ${result.mode}, ${result.recallTimeMs}ms)`;
  }

  const lines: string[] = [
    `[Gnosys Recall] ${result.memories.length} memories (mode: ${result.mode}, ${result.recallTimeMs}ms)`,
    "",
  ];

  for (const m of result.memories) {
    const archive = m.fromArchive ? " [ARCHIVED]" : "";
    const score = m.relevanceScore.toFixed(2);
    lines.push(`• ${m.title}${archive} (relevance: ${score})`);
    lines.push(`  Category: ${m.category} | Confidence: ${m.confidence}`);
    lines.push(`  Path: ${m.path}`);
    if (m.snippet) {
      lines.push(`  ${m.snippet.substring(0, 150).replace(/\n/g, " ").trim()}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
