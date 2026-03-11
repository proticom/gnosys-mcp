/**
 * Gnosys Recall — Automatic memory injection via MCP Resource.
 *
 * The host (Cursor, Claude Desktop, Claude Code, Cowork) reads the
 * gnosys://recall resource on every turn. This module runs the fast
 * FTS5 lookup and returns a citation-heavy <gnosys-recall> block that
 * gets injected into the model context automatically — no tool call needed.
 *
 * Pipeline: FTS5 keyword search → relevance scoring → aggressive/filtered
 *           selection → archive fallback → format as [[wikilink]] block.
 *
 * Config (gnosys.json):
 *   "recall": { "aggressive": true, "maxMemories": 8, "minRelevance": 0.4 }
 *
 * When aggressive=true (default): inject top memories even if relevance is
 * medium. This boosts recall in long sessions where context drifts.
 *
 * v2.0: When GnosysDB is available, recall runs entirely from SQLite —
 * no filesystem reads, no separate search.db. Pure DB lookup. Sub-10ms.
 *
 * No LLM calls. No embeddings. Pure index lookup. Sub-50ms.
 */

import { GnosysSearch } from "./search.js";
import { GnosysResolver } from "./resolver.js";
import { GnosysArchive } from "./archive.js";
import { GnosysDB } from "./db.js";
import { auditLog } from "./audit.js";
import { RecallConfig } from "./config.js";

export interface RecallResult {
  memories: RecallMemory[];
  totalActive: number;
  totalArchived: number;
  recallTimeMs: number;
  aggressive: boolean;
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

/** Default recall config */
const DEFAULT_RECALL_CONFIG: RecallConfig = {
  aggressive: true,
  maxMemories: 8,
  minRelevance: 0.4,
};

/**
 * Normalize FTS5 rank to a 0-1 relevance score.
 * FTS5 rank is negative (closer to 0 = more relevant).
 * We map it to 0-1 where 1 = most relevant.
 */
function normalizeRank(rank: number, allRanks: number[]): number {
  if (allRanks.length === 0) return 0.5;
  if (allRanks.length === 1) return 0.9;

  const minRank = Math.min(...allRanks); // Most relevant (most negative)
  const maxRank = Math.max(...allRanks); // Least relevant

  if (maxRank === minRank) return 0.9;

  // Linear normalization: most negative → 1.0, least negative → 0.3
  return 0.3 + 0.7 * ((maxRank - rank) / (maxRank - minRank));
}

/**
 * Fast recall — keyword search only, no LLM, no embeddings.
 * Designed to run on every host turn via MCP Resource (sub-50ms target).
 *
 * v2.0: When gnosysDb is provided, recall runs entirely from SQLite.
 * No filesystem reads. Sub-10ms.
 *
 * When aggressive=true (default):
 *   - Always returns up to maxMemories regardless of relevance score
 *   - Uses minRelevance as a soft floor, not a hard cutoff
 *   - Injects even medium-relevance memories to boost context in long sessions
 *
 * When aggressive=false:
 *   - Only returns memories above minRelevance threshold
 *   - May return zero memories if nothing matches well
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
    /** v2.0: When provided, recall uses SQLite directly — no filesystem reads */
    gnosysDb?: GnosysDB;
  }
): Promise<RecallResult> {
  const start = performance.now();
  const cfg = options.recallConfig || DEFAULT_RECALL_CONFIG;
  const limit = options.limit || cfg.maxMemories;

  // ─── v2.0 DB-backed fast path ──────────────────────────────────────
  if (options.gnosysDb?.isAvailable() && options.gnosysDb?.isMigrated()) {
    return recallFromDb(query, options.gnosysDb, limit, cfg, options.traceId);
  }

  // ─── v1.x legacy path (filesystem + search.db) ────────────────────
  const memories: RecallMemory[] = [];

  // Step 1: Fast keyword search on active memories (FTS5 — sub-10ms)
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

  // Step 2: Archive fallback if active results are thin
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
              relevanceScore: 0.5,
            });
          }
        }
        archive.close();
      }
    } catch {
      // Archive not available — degrade gracefully
    }
  }

  // Step 3: Apply filtering
  const result = applyRecallFiltering(memories, activeResults.length, totalArchived, limit, cfg, start);

  auditLog({
    operation: "recall",
    query,
    resultCount: result.memories.length,
    durationMs: result.recallTimeMs,
    traceId: options.traceId,
    details: {
      aggressive: cfg.aggressive,
      totalCandidates: memories.length,
      filtered: result.memories.length,
    },
  });

  return result;
}

/**
 * v2.0 DB-backed recall — runs entirely from gnosys.db.
 * No filesystem reads. No separate search.db. Sub-10ms target.
 */
function recallFromDb(
  query: string,
  db: GnosysDB,
  limit: number,
  cfg: RecallConfig,
  traceId?: string
): RecallResult {
  const start = performance.now();
  const memories: RecallMemory[] = [];

  // Step 1: FTS5 discover on gnosys.db
  const fetchLimit = Math.max(limit * 2, 15);
  const dbResults = db.discoverFts(query, fetchLimit);
  const allRanks = dbResults.map((r) => r.rank);

  for (const r of dbResults) {
    const mem = db.getMemory(r.id);
    if (mem && mem.tier === "active" && mem.status === "active") {
      const relevanceScore = normalizeRank(r.rank, allRanks);
      memories.push({
        id: mem.id,
        title: mem.title,
        category: mem.category,
        relevance: mem.relevance || "",
        confidence: mem.confidence,
        path: mem.id,
        fromArchive: false,
        snippet: mem.content.substring(0, 300),
        relevanceScore,
      });
    }
  }

  // Step 2: Archive tier fallback if active results are thin
  const counts = db.getMemoryCount();
  if (memories.length < limit) {
    for (const r of dbResults) {
      if (memories.length >= limit) break;
      const mem = db.getMemory(r.id);
      if (mem && mem.tier === "archive") {
        const existingIds = new Set(memories.map((m) => m.id));
        if (!existingIds.has(mem.id)) {
          const relevanceScore = normalizeRank(r.rank, allRanks);
          memories.push({
            id: mem.id,
            title: mem.title,
            category: mem.category,
            relevance: mem.relevance || "",
            confidence: mem.confidence,
            path: mem.id,
            fromArchive: true,
            snippet: mem.content.substring(0, 300),
            relevanceScore,
          });
        }
      }
    }
  }

  // Step 3: Apply same filtering logic
  const result = applyRecallFiltering(
    memories,
    dbResults.filter((r) => {
      const m = db.getMemory(r.id);
      return m && m.tier === "active";
    }).length,
    counts.archived,
    limit,
    cfg,
    start
  );

  // Audit via db instead of JSONL
  db.logAudit({
    timestamp: new Date().toISOString(),
    operation: "recall",
    memory_id: null,
    details: JSON.stringify({
      query,
      aggressive: cfg.aggressive,
      totalCandidates: memories.length,
      filtered: result.memories.length,
    }),
    duration_ms: Math.round(result.recallTimeMs),
    trace_id: traceId || null,
  });

  return result;
}

/**
 * Shared filtering logic for both v1.x and v2.0 paths.
 */
function applyRecallFiltering(
  memories: RecallMemory[],
  totalActive: number,
  totalArchived: number,
  limit: number,
  cfg: RecallConfig,
  startTime: number
): RecallResult {
  const sorted = [...memories].sort((a, b) => b.relevanceScore - a.relevanceScore);
  let filtered: RecallMemory[];

  if (cfg.aggressive) {
    const guaranteed = sorted.slice(0, 3);
    const rest = sorted.slice(3).filter((m) => m.relevanceScore >= cfg.minRelevance);
    filtered = [...guaranteed, ...rest].slice(0, limit);
  } else {
    filtered = sorted.filter((m) => m.relevanceScore >= cfg.minRelevance).slice(0, limit);
  }

  const elapsed = performance.now() - startTime;

  return {
    memories: filtered,
    totalActive,
    totalArchived,
    recallTimeMs: Math.round(elapsed * 100) / 100,
    aggressive: cfg.aggressive,
  };
}

/**
 * Format recall results as a host-friendly <gnosys-recall> block.
 * This is what gets injected into the model context on every turn
 * via the MCP Resource. Citation-heavy with [[wikilinks]].
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
  const mode = result.aggressive ? "aggressive" : "filtered";
  if (result.memories.length === 0) {
    return `[Gnosys Recall] No relevant memories found. (${mode}, ${result.recallTimeMs}ms)`;
  }

  const lines: string[] = [
    `[Gnosys Recall] ${result.memories.length} memories (${mode}, ${result.recallTimeMs}ms)`,
    "",
  ];

  for (const m of result.memories) {
    const archive = m.fromArchive ? " [ARCHIVED]" : "";
    const score = m.relevanceScore.toFixed(2);
    lines.push(`• ${m.title}${archive} (relevance: ${score})`);
    lines.push(`  Category: ${m.category} | Confidence: ${m.confidence}`);
    lines.push(`  Path: [[${m.path}]]`);
    if (m.snippet) {
      lines.push(`  ${m.snippet.substring(0, 150).replace(/\n/g, " ").trim()}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
