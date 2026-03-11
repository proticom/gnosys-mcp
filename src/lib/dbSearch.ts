/**
 * Gnosys DB Search Adapter — bridges GnosysDB to existing search interfaces.
 *
 * When gnosys.db is migrated and available, this adapter replaces:
 *   - GnosysSearch (FTS5 keyword search)
 *   - GnosysEmbeddings (vector cosine similarity)
 *   - GnosysArchive (search in archived memories)
 *
 * Implements the same result types so consumers (recall, hybridSearch, ask)
 * work without modification.
 */

import { GnosysDB, DbMemory } from "./db.js";
import { SearchResult, DiscoverResult } from "./search.js";
import { HybridSearchResult, SearchMode } from "./hybridSearch.js";

// ─── Cosine similarity for inline embeddings ────────────────────────────

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function bufferToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ─── DB Search Adapter ──────────────────────────────────────────────────

export class GnosysDbSearch {
  private db: GnosysDB;

  constructor(db: GnosysDB) {
    this.db = db;
  }

  /**
   * FTS5 search — compatible with GnosysSearch.search()
   */
  search(query: string, limit: number = 20): SearchResult[] {
    const results = this.db.searchFts(query, limit);
    return results.map((r) => ({
      relative_path: r.id,      // In db mode, we use memory ID as the key
      title: r.title,
      snippet: r.snippet,
      rank: r.rank,
    }));
  }

  /**
   * FTS5 discover — compatible with GnosysSearch.discover()
   */
  discover(query: string, limit: number = 20): DiscoverResult[] {
    const results = this.db.discoverFts(query, limit);
    return results.map((r) => ({
      relative_path: r.id,      // In db mode, we use memory ID as the key
      title: r.title,
      relevance: r.relevance,
      rank: r.rank,
    }));
  }

  /**
   * Hybrid search — all-in-one: FTS5 + optional semantic + archive tier.
   * Replaces GnosysHybridSearch.hybridSearch() when db is available.
   */
  async hybridSearch(
    query: string,
    limit: number = 15,
    mode: SearchMode = "hybrid",
    embedQuery?: (text: string) => Promise<Float32Array>
  ): Promise<HybridSearchResult[]> {
    const RRF_K = 60;

    // Check if we have embeddings for semantic/hybrid
    const hasEmbeddings = this.db.getAllEmbeddings().length > 0;
    if ((mode === "hybrid" || mode === "semantic") && !hasEmbeddings) {
      if (mode === "semantic") return [];
      mode = "keyword";
    }

    let results: HybridSearchResult[];

    if (mode === "keyword") {
      results = this.keywordSearch(query, limit);
    } else if (mode === "semantic" && embedQuery) {
      results = await this.semanticSearch(query, limit, embedQuery);
    } else if (mode === "hybrid" && embedQuery) {
      const [kw, sem] = await Promise.all([
        this.keywordSearch(query, limit * 2),
        this.semanticSearch(query, limit * 2, embedQuery),
      ]);
      results = this.rrfFusion(kw, sem, limit);
    } else {
      results = this.keywordSearch(query, limit);
    }

    // Fill in from archive tier if active results are thin
    if (results.length < limit) {
      const archiveResults = this.searchArchiveTier(query, limit - results.length);
      const existingIds = new Set(results.map((r) => r.relativePath));
      const newResults = archiveResults.filter((r) => !existingIds.has(r.relativePath));
      results = [...results, ...newResults];
    }

    return results.slice(0, limit);
  }

  /**
   * FTS5 keyword search → HybridSearchResult
   */
  private keywordSearch(query: string, limit: number): HybridSearchResult[] {
    const results = this.db.searchFts(query, limit);
    return results.map((r, i) => ({
      relativePath: r.id,
      title: r.title,
      snippet: r.snippet,
      score: 1 / (60 + i + 1),
      sources: ["keyword"] as ("keyword" | "semantic" | "archive")[],
      memoryId: r.id,
      fromArchive: false,
    }));
  }

  /**
   * Semantic search using inline embeddings
   */
  private async semanticSearch(
    query: string,
    limit: number,
    embedQuery: (text: string) => Promise<Float32Array>
  ): Promise<HybridSearchResult[]> {
    const queryVec = await embedQuery(query);
    const allEmbeddings = this.db.getAllEmbeddings();

    const scored: Array<{ id: string; similarity: number }> = [];
    for (const entry of allEmbeddings) {
      const vec = bufferToFloat32(entry.embedding);
      const sim = cosineSimilarity(queryVec, vec);
      scored.push({ id: entry.id, similarity: sim });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const topN = scored.slice(0, limit);

    const results: HybridSearchResult[] = [];
    for (const item of topN) {
      const mem = this.db.getMemory(item.id);
      if (mem) {
        results.push({
          relativePath: mem.id,
          title: mem.title,
          snippet: mem.content.substring(0, 200),
          score: item.similarity,
          sources: ["semantic"],
          memoryId: mem.id,
          fromArchive: mem.tier === "archive",
        });
      }
    }
    return results;
  }

  /**
   * Search archive tier (memories with tier='archive')
   */
  private searchArchiveTier(query: string, limit: number): HybridSearchResult[] {
    // Use FTS5 but filter to archive tier after
    const results = this.db.searchFts(query, limit * 2);
    const archiveResults: HybridSearchResult[] = [];

    for (const r of results) {
      const mem = this.db.getMemory(r.id);
      if (mem && mem.tier === "archive") {
        archiveResults.push({
          relativePath: mem.id,
          title: mem.title,
          snippet: r.snippet,
          score: 0.001,
          sources: ["archive"],
          memoryId: mem.id,
          fromArchive: true,
        });
        if (archiveResults.length >= limit) break;
      }
    }
    return archiveResults;
  }

  /**
   * RRF fusion of keyword + semantic results
   */
  private rrfFusion(
    keywordResults: HybridSearchResult[],
    semanticResults: HybridSearchResult[],
    limit: number
  ): HybridSearchResult[] {
    const RRF_K = 60;
    const scoreMap = new Map<string, {
      score: number;
      result: HybridSearchResult;
      sources: Set<"keyword" | "semantic">;
    }>();

    for (let i = 0; i < keywordResults.length; i++) {
      const r = keywordResults[i];
      scoreMap.set(r.relativePath, {
        score: 1 / (RRF_K + i + 1),
        result: r,
        sources: new Set(["keyword"]),
      });
    }

    for (let i = 0; i < semanticResults.length; i++) {
      const r = semanticResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      const existing = scoreMap.get(r.relativePath);
      if (existing) {
        existing.score += rrfScore;
        existing.sources.add("semantic");
      } else {
        scoreMap.set(r.relativePath, {
          score: rrfScore,
          result: r,
          sources: new Set(["semantic"]),
        });
      }
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({
        ...entry.result,
        score: entry.score,
        sources: Array.from(entry.sources),
      }));
  }

  /**
   * Load full content for search results (used by Ask engine).
   * In DB mode, we read directly from the memories table.
   */
  loadContent(results: HybridSearchResult[]): HybridSearchResult[] {
    return results.map((r) => {
      if (r.memoryId) {
        const mem = this.db.getMemory(r.memoryId);
        if (mem) {
          return { ...r, fullContent: mem.content, memoryId: mem.id };
        }
      }
      return r;
    });
  }

  /**
   * Get a memory by ID (replaces resolver.readMemory for db mode)
   */
  getMemory(id: string): DbMemory | null {
    return this.db.getMemory(id);
  }

  /**
   * Check if embeddings exist in the db
   */
  hasEmbeddings(): boolean {
    return this.db.getAllEmbeddings().length > 0;
  }

  /**
   * Get embedding count
   */
  embeddingCount(): number {
    return this.db.getAllEmbeddings().length;
  }
}
