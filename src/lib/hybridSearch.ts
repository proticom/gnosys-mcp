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

export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface HybridSearchResult {
  relativePath: string;
  title: string;
  snippet: string;
  score: number;
  /** Which method(s) found this result */
  sources: ("keyword" | "semantic")[];
  /** Full memory content (loaded on demand for ask engine) */
  content?: string;
  /** The memory frontmatter content field */
  fullContent?: string;
}

/** RRF constant k — standard value from Cormack et al. 2009 */
const RRF_K = 60;

export class GnosysHybridSearch {
  private search: GnosysSearch;
  private embeddings: GnosysEmbeddings;
  private resolver: GnosysResolver;
  private storePath: string;

  constructor(
    search: GnosysSearch,
    embeddings: GnosysEmbeddings,
    resolver: GnosysResolver,
    storePath: string
  ) {
    this.search = search;
    this.embeddings = embeddings;
    this.resolver = resolver;
    this.storePath = storePath;
  }

  /**
   * Main hybrid search entry point.
   */
  async hybridSearch(
    query: string,
    limit: number = 15,
    mode: SearchMode = "hybrid"
  ): Promise<HybridSearchResult[]> {
    // Auto-downgrade to keyword if no embeddings available
    if (mode === "hybrid" || mode === "semantic") {
      if (!this.embeddings.hasEmbeddings()) {
        if (mode === "semantic") {
          return []; // Can't do semantic without embeddings
        }
        mode = "keyword"; // Downgrade hybrid to keyword
      }
    }

    if (mode === "keyword") {
      return this.keywordSearch(query, limit);
    }

    if (mode === "semantic") {
      return this.semanticSearch(query, limit);
    }

    // Hybrid: run both and fuse with RRF
    const [keywordResults, semanticResults] = await Promise.all([
      this.keywordSearch(query, limit * 2),
      this.semanticSearch(query, limit * 2),
    ]);

    return this.rrfFusion(keywordResults, semanticResults, limit);
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
   */
  async loadContent(results: HybridSearchResult[]): Promise<HybridSearchResult[]> {
    const enriched: HybridSearchResult[] = [];

    for (const r of results) {
      const memory = await this.resolver.readMemory(r.relativePath);
      if (memory) {
        enriched.push({
          ...r,
          fullContent: memory.content,
        });
      } else {
        enriched.push(r);
      }
    }

    return enriched;
  }

  /**
   * Check if embeddings are available.
   */
  hasEmbeddings(): boolean {
    return this.embeddings.hasEmbeddings();
  }

  /**
   * Get embedding count.
   */
  embeddingCount(): number {
    return this.embeddings.count();
  }
}
