/**
 * Gnosys Search — SQLite FTS5 keyword index for fast text search.
 * FTS5-based search and discovery across all Gnosys stores.
 */

import Database from "better-sqlite3";
import path from "path";
import { GnosysStore, Memory } from "./store.js";

export interface SearchResult {
  relative_path: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface DiscoverResult {
  relative_path: string;
  title: string;
  relevance: string;
  rank: number;
}

export class GnosysSearch {
  private db!: Database.Database;
  private storePath: string;

  constructor(storePath: string) {
    this.storePath = storePath;
    // Try file-based DB first, fall back to in-memory.
    // We must verify writes actually work — some filesystems (e.g., mounted
    // volumes in sandboxed environments) allow file creation but block the
    // journal/WAL delete operations that SQLite requires.
    try {
      const dbPath = path.join(storePath, ".gnosys", "search.db");
      this.db = new Database(dbPath);
      this.initSchema();
      // Smoke-test: insert + delete to confirm journal ops work
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS _write_test (v INTEGER); INSERT INTO _write_test VALUES (1); DELETE FROM _write_test; DROP TABLE _write_test;"
      );
    } catch {
      // Fallback to in-memory (works everywhere, rebuilt on each start)
      try { this.db?.close(); } catch { /* ignore */ }
      this.db = new Database(":memory:");
      this.initSchema();
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        relative_path,
        title,
        category,
        tags,
        relevance,
        content,
        tokenize='porter unicode61'
      );
    `);
  }

  /**
   * Clear the entire search index.
   */
  clearIndex(): void {
    this.db.exec("DELETE FROM memories_fts");
  }

  /**
   * Rebuild the entire search index from a single store.
   * Clears all existing entries first.
   */
  async reindex(store: GnosysStore): Promise<number> {
    this.clearIndex();
    return this.addStoreMemories(store);
  }

  /**
   * Add memories from a store to the index WITHOUT clearing existing entries.
   * Used for multi-store indexing: clear once, then addStoreMemories for each store.
   * Optional storeLabel prefix is prepended to relative_path for disambiguation.
   */
  async addStoreMemories(store: GnosysStore, storeLabel?: string): Promise<number> {
    const memories = await store.getAllMemories();

    const insert = this.db.prepare(
      "INSERT INTO memories_fts (relative_path, title, category, tags, relevance, content) VALUES (?, ?, ?, ?, ?, ?)"
    );

    const tx = this.db.transaction(() => {
      for (const m of memories) {
        const tags = Array.isArray(m.frontmatter.tags)
          ? m.frontmatter.tags.join(" ")
          : Object.values(m.frontmatter.tags).flat().join(" ");

        const relevance = (m.frontmatter.relevance as string) || "";

        const indexPath = storeLabel
          ? `${storeLabel}:${m.relativePath}`
          : m.relativePath;

        insert.run(
          indexPath,
          m.frontmatter.title,
          m.frontmatter.category,
          tags,
          relevance,
          m.content
        );
      }
    });

    tx();
    return memories.length;
  }

  /**
   * Search memories by keyword query.
   */
  search(query: string, limit: number = 20): SearchResult[] {
    // FTS5 query — escape special characters
    const safeQuery = query.replace(/['"]/g, "").trim();
    if (!safeQuery) return [];

    const stmt = this.db.prepare(`
      SELECT
        relative_path,
        title,
        snippet(memories_fts, 5, '>>>', '<<<', '...', 40) as snippet,
        rank
      FROM memories_fts
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    try {
      return stmt.all(safeQuery, limit) as SearchResult[];
    } catch {
      // If FTS5 query fails, fall back to simple LIKE search
      const likeStmt = this.db.prepare(`
        SELECT
          relative_path,
          title,
          substr(content, 1, 200) as snippet,
          0 as rank
        FROM memories_fts
        WHERE content LIKE ? OR title LIKE ? OR tags LIKE ?
        LIMIT ?
      `);
      const pattern = `%${safeQuery}%`;
      return likeStmt.all(pattern, pattern, pattern, limit) as SearchResult[];
    }
  }

  /**
   * Discover memories by searching relevance keyword clouds.
   * Returns lightweight metadata only — no file contents.
   * This is the primary discovery mechanism replacing the static manifest.
   */
  discover(query: string, limit: number = 20): DiscoverResult[] {
    const safeQuery = query.replace(/['"]/g, "").trim();
    if (!safeQuery) return [];

    // Search primarily on relevance + title + tags (not content body)
    // FTS5 column filter: {relevance title tags}
    const stmt = this.db.prepare(`
      SELECT
        relative_path,
        title,
        relevance,
        rank
      FROM memories_fts
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    try {
      // Try column-filtered search on relevance/title/tags first
      const colQuery = `{relevance title tags} : ${safeQuery}`;
      const results = stmt.all(colQuery, limit) as DiscoverResult[];
      if (results.length > 0) return results;

      // Fall back to full-text search if column filter finds nothing
      return stmt.all(safeQuery, limit) as DiscoverResult[];
    } catch {
      // If FTS5 column filter syntax fails, fall back to full search
      try {
        return stmt.all(safeQuery, limit) as DiscoverResult[];
      } catch {
        return [];
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
