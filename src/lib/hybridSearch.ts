/**
 * Gnosys Hybrid Search — Combines FTS5 keyword search with semantic embeddings
 * using Reciprocal Rank Fusion (RRF).
 *
 * Three modes:
 *   keyword  — FTS5 only (fast, no model needed)
 *   semantic — embeddings cosine similarity only
 *   hybrid   — RRF fusion of both (default when embeddings exist)
 */

import { GnosysSearch, SearchResult } from "./search.js";
import { GnosysEmbeddings } from "./embeddings.js";
import { GnosysStore, Memory } from "./store.js";
import { GnosysResolver, LayeredMemory } from "./resolver.js";
import { GnosysArchive, ArchiveSearchResult } from "./archive.js";
import { GnosysDbSearch } from "./dbSearch.js";
import { GnosysDB } from "./db.js";

export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface HybridSearchResult {
  relativePath: string;
  title: string;
  snippet: string;
  score: number;
  /** Which method(s) found this result */
  sources: ("keyword" | "semantic" | "archive")[];
  /** Full memory content (loaded on demand for ask engine) */
  content?: string;
  /** The memory frontmatter content field */
  fullContent?: string;
  /** Memory ID (used for dearchiving) */
  memoryId?: string;
  /** Whether this result came from the archive */
  fromArchive?: boolean;
}

/** RRF constant k — standard value from Cormack et al. 2009 */
const RRF_K = 60;

export class GnosysHybridSearch {
  private search: GnosysSearch;
  private embeddings: GnosysEmbeddings;
  private resolver: GnosysResolver;
  private storePath: string;
  /** v2.0: When set, hybrid search uses SQLite directly */
  private dbSearch: GnosysDbSearch | null = null;

  constructor(
    search: GnosysSearch,
    embeddings: GnosysEmbeddings,
    resolver: GnosysResolver,
    storePath: string,
    gnosysDb?: GnosysDB
  ) {
    this.search = search;
    this.embeddings = embeddings;
    this.resolver = resolver;
    this.storePath = storePath;

    // v2.0: If GnosysDB is migrated, create a DB search adapter
    if (gnosysDb?.isAvailable() && gnosysDb?.isMigrated()) {
      this.dbSearch = new GnosysDbSearch(gnosysDb);
    }
  }

  /**
   * Main hybrid search entry point.
   * Searches active memories first; if results are insufficient, also searches archive.db.
   */
  async hybridSearch(
    query: string,
    limit: number = 15,
    mode: SearchMode = "hybrid"
  ): Promise<HybridSearchResult[]> {
    // v2.0 DB-backed fast path: run entirely from gnosys.db
    if (this.dbSearch) {
      const embedQuery = this.embeddings.hasEmbeddings()
        ? (text: string) => this.embeddings.embed(text)
        : undefined;
      return this.dbSearch.hybridSearch(query, limit, mode, embedQuery);
    }

    // Auto-downgrade to keyword if no embeddings available
    if (mode === "hybrid" || mode === "semantic") {
      if (!this.embeddings.hasEmbeddings()) {
        if (mode === "semantic") {
          return []; // Can't do semantic without embeddings
        }
        mode = "keyword"; // Downgrade hybrid to keyword
      }
    }

    let results: HybridSearchResult[];

    if (mode === "keyword") {
      results = this.keywordSearch(query, limit);
    } else if (mode === "semantic") {
      results = await this.semanticSearch(query, limit);
    } else {
      // Hybrid: run both and fuse with RRF
      const [keywordResults, semanticResults] = await Promise.all([
        this.keywordSearch(query, limit * 2),
        this.semanticSearch(query, limit * 2),
      ]);
      results = this.rrfFusion(keywordResults, semanticResults, limit);
    }

    // If active results are insufficient, search archive.db
    if (results.length < limit) {
      const archiveResults = this.searchArchive(query, limit - results.length);
      if (archiveResults.length > 0) {
        // Deduplicate by title (archive results won't have same relativePath)
        const existingTitles = new Set(results.map((r) => r.title.toLowerCase()));
        const newArchiveResults = archiveResults.filter(
          (ar) => !existingTitles.has(ar.title.toLowerCase())
        );
        results = [...results, ...newArchiveResults];
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Search the archive.db for memories.
   */
  private searchArchive(query: string, limit: number): HybridSearchResult[] {
    try {
      const archive = new GnosysArchive(this.storePath);
      if (!archive.isAvailable()) return [];

      const archiveResults = archive.searchArchive(query, limit);
      archive.close();

      return archiveResults.map((ar) => ({
        relativePath: `archive:${ar.category}/${ar.id}`,
        title: ar.title,
        snippet: ar.snippet,
        score: Math.abs(ar.score) > 0 ? 1 / (RRF_K + Math.abs(ar.score)) : 0.001,
        sources: ["archive"] as ("keyword" | "semantic" | "archive")[],
        memoryId: ar.id,
        fromArchive: true,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Keyword search via existing FTS5.
   */
  private keywordSearch(query: string, limit: number): HybridSearchResult[] {
    const results = this.search.search(query, limit);
    return results.map((r, i) => ({
      relativePath: r.relative_path,
      title: r.title,
      snippet: r.snippet,
      score: 1 / (RRF_K + i + 1), // RRF score based on rank position
      sources: ["keyword"] as ("keyword" | "semantic")[],
    }));
  }

  /**
   * Semantic search via embeddings cosine similarity.
   */
  private async semanticSearch(
    query: string,
    limit: number
  ): Promise<HybridSearchResult[]> {
    // Embed the query
    const queryEmbedding = await this.embeddings.embed(query);

    // Get all stored embeddings and compute similarities
    const allEmbeddings = this.embeddings.getAllEmbeddings();
    const scored: { filePath: string; similarity: number }[] = [];

    for (const entry of allEmbeddings) {
      const similarity = GnosysEmbeddings.cosineSimilarity(
        queryEmbedding,
        entry.embedding
      );
      scored.push({ filePath: entry.filePath, similarity });
    }

    // Sort by similarity descending
    scored.sort((a, b) => b.similarity - a.similarity);
    const topN = scored.slice(0, limit);

    // Load memory metadata for results
    const results: HybridSearchResult[] = [];
    for (const item of topN) {
      const memory = await this.resolver.readMemory(item.filePath);
      if (memory) {
        results.push({
          relativePath: item.filePath,
          title: memory.frontmatter.title,
          snippet: memory.content.substring(0, 200),
          score: item.similarity,
          sources: ["semantic"],
        });
      }
    }

    return results;
  }

  /**
   * Reciprocal Rank Fusion — combines two ranked lists.
   * RRF score: score(d) = Σ 1/(k + rank_i(d)) for each ranking system i
   */
  private rrfFusion(
    keywordResults: HybridSearchResult[],
    semanticResults: HybridSearchResult[],
    limit: number
  ): HybridSearchResult[] {
    const scoreMap = new Map<
      string,
      { score: number; result: HybridSearchResult; sources: Set<"keyword" | "semantic"> }
    >();

    // Score keyword results
    for (let i = 0; i < keywordResults.length; i++) {
      const r = keywordResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      scoreMap.set(r.relativePath, {
        score: rrfScore,
        result: r,
        sources: new Set(["keyword"]),
      });
    }

    // Score semantic results and merge
    for (let i = 0; i < semanticResults.length; i++) {
      const r = semanticResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      const existing = scoreMap.get(r.relativePath);

      if (existing) {
        existing.score += rrfScore;
        existing.sources.add("semantic");
        // Use semantic snippet if keyword snippet is empty
        if (!existing.result.snippet && r.snippet) {
          existing.result.snippet = r.snippet;
        }
      } else {
        scoreMap.set(r.relativePath, {
          score: rrfScore,
          result: r,
          sources: new Set(["semantic"]),
        });
      }
    }

    // Sort by combined RRF score descending
    const fused = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({
        ...entry.result,
        score: entry.score,
        sources: Array.from(entry.sources),
      }));

    return fused;
  }

  /**
   * Reindex all embeddings from all stores.
   * Returns count of files indexed.
   */
  async reindex(
    onProgress?: (current: number, total: number, filePath: string) => void
  ): Promise<number> {
    // Gather all memories from all stores
    const allMemories: LayeredMemory[] = await this.resolver.getAllMemories();

    // Clear existing embeddings
    this.embeddings.clear();

    let indexed = 0;
    const total = allMemories.length;

    // Process in batches for efficiency
    const batchSize = 32;
    for (let i = 0; i < allMemories.length; i += batchSize) {
      const batch = allMemories.slice(i, i + batchSize);

      // Prepare texts: combine title + relevance + content for embedding
      const texts = batch.map((m) => {
        const tags = Array.isArray(m.frontmatter.tags)
          ? m.frontmatter.tags.join(" ")
          : Object.values(m.frontmatter.tags).flat().join(" ");
        return `${m.frontmatter.title}\n${m.frontmatter.relevance || ""}\n${tags}\n${m.content}`;
      });

      const embeddings = await this.embeddings.embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const memory = batch[j];
        const embedding = embeddings[j];
        const hash = GnosysEmbeddings.contentHash(texts[j]);

        // Use the store-prefixed path for multi-store support
        const indexPath = `${memory.sourceLabel}:${memory.relativePath}`;

        this.embeddings.storeEmbedding(indexPath, embedding, hash);
        indexed++;

        onProgress?.(indexed, total, memory.relativePath);
      }
    }

    return indexed;
  }

  /**
   * Load full content for search results (used by Ask engine).
   * Handles both active memories and archived memories.
   */
  async loadContent(results: HybridSearchResult[]): Promise<HybridSearchResult[]> {
    // v2.0 DB-backed fast path
    if (this.dbSearch) {
      return this.dbSearch.loadContent(results);
    }

    const enriched: HybridSearchResult[] = [];
    let archive: GnosysArchive | null = null;

    for (const r of results) {
      if (r.fromArchive && r.memoryId) {
        // Load from archive
        if (!archive) {
          archive = new GnosysArchive(this.storePath);
        }
        if (archive.isAvailable()) {
          const archived = archive.getArchivedMemory(r.memoryId);
          if (archived) {
            enriched.push({
              ...r,
              fullContent: archived.content,
            });
            continue;
          }
        }
        enriched.push(r);
      } else {
        const memory = await this.resolver.readMemory(r.relativePath);
        if (memory) {
          enriched.push({
            ...r,
            fullContent: memory.content,
            memoryId: memory.frontmatter.id,
          });
        } else {
          enriched.push(r);
        }
      }
    }

    archive?.close();
    return enriched;
  }

  /**
   * Check if embeddings are available.
   */
  hasEmbeddings(): boolean {
    if (this.dbSearch) return this.dbSearch.hasEmbeddings();
    return this.embeddings.hasEmbeddings();
  }

  /**
   * Get embedding count.
   */
  embeddingCount(): number {
    if (this.dbSearch) return this.dbSearch.embeddingCount();
    return this.embeddings.count();
  }
}
