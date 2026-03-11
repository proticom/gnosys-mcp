/**
 * Gnosys Archive — Two-Tier Memory (Active + Archive).
 *
 * Active layer: .gnosys/<category>/*.md (atomic markdown with YAML frontmatter)
 * Archive layer: .gnosys/archive.db (SQLite — reuses existing better-sqlite3)
 *
 * Bidirectional flow:
 *   maintain → moves old/low-confidence memories from active → archive.db
 *   search/ask → searches archive if active results insufficient,
 *                then dearchives used memories back to active
 */

// Dynamic import — gracefully handles missing native module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  // better-sqlite3 native module not available — archive degrades gracefully
}

import path from "path";
import fs from "fs/promises";
import { statSync } from "fs";
import matter from "gray-matter";
import { GnosysStore, Memory, MemoryFrontmatter } from "./store.js";
import { GnosysConfig } from "./config.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface ArchivedMemory {
  id: string;
  title: string;
  content: string;
  yaml_frontmatter: string;
  tags: string;
  confidence: number;
  last_reinforced: string | null;
  archived_date: string;
  category: string;
  original_path: string;
}

export interface ArchiveStats {
  totalArchived: number;
  dbSizeMB: number;
  oldestArchived: string | null;
  newestArchived: string | null;
}

export interface ArchiveSearchResult {
  id: string;
  title: string;
  snippet: string;
  score: number;
  tags: string;
  category: string;
}

// ─── Archive Manager ────────────────────────────────────────────────────

export class GnosysArchive {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any = null;
  private storePath: string;
  private available = false;

  constructor(storePath: string) {
    this.storePath = storePath;

    if (!Database) return;

    try {
      const dbPath = path.join(storePath, "archive.db");
      this.db = new Database(dbPath);
      this.initSchema();
      this.available = true;
    } catch {
      // Archive not available — two-tier degrades gracefully
      this.db = null;
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archived_memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        yaml_frontmatter TEXT NOT NULL,
        tags TEXT DEFAULT '',
        confidence REAL DEFAULT 0.8,
        last_reinforced TEXT,
        archived_date TEXT NOT NULL,
        category TEXT NOT NULL,
        original_path TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(
        id,
        title,
        tags,
        content,
        tokenize='porter unicode61'
      );
    `);
  }

  /**
   * Whether the archive is available (better-sqlite3 loaded + DB opened).
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Get archive stats.
   */
  getStats(): ArchiveStats {
    if (!this.db) {
      return { totalArchived: 0, dbSizeMB: 0, oldestArchived: null, newestArchived: null };
    }

    const count = this.db.prepare("SELECT COUNT(*) as cnt FROM archived_memories").get() as { cnt: number };
    const oldest = this.db.prepare("SELECT MIN(archived_date) as d FROM archived_memories").get() as { d: string | null };
    const newest = this.db.prepare("SELECT MAX(archived_date) as d FROM archived_memories").get() as { d: string | null };

    let dbSizeMB = 0;
    try {
      const dbPath = path.join(this.storePath, "archive.db");
      dbSizeMB = statSync(dbPath).size / (1024 * 1024);
    } catch {
      // Ignore
    }

    return {
      totalArchived: count.cnt,
      dbSizeMB,
      oldestArchived: oldest.d,
      newestArchived: newest.d,
    };
  }

  /**
   * Archive a memory: move from active markdown → archive.db.
   * Returns true if successfully archived.
   */
  async archiveMemory(memory: Memory): Promise<boolean> {
    if (!this.db) return false;

    const tags = Array.isArray(memory.frontmatter.tags)
      ? memory.frontmatter.tags.join(" ")
      : Object.values(memory.frontmatter.tags).flat().join(" ");

    const today = new Date().toISOString().split("T")[0];

    // Serialize full frontmatter as YAML for lossless restoration
    const yamlFrontmatter = JSON.stringify(memory.frontmatter);

    const insertMem = this.db.prepare(`
      INSERT OR REPLACE INTO archived_memories
        (id, title, content, yaml_frontmatter, tags, confidence, last_reinforced, archived_date, category, original_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = this.db.prepare(`
      INSERT INTO archive_fts (id, title, tags, content)
      VALUES (?, ?, ?, ?)
    `);

    // Check if already in FTS (to avoid duplicates)
    const existsFts = this.db.prepare("SELECT id FROM archive_fts WHERE id = ?").get(memory.frontmatter.id);

    const tx = this.db.transaction(() => {
      insertMem.run(
        memory.frontmatter.id,
        memory.frontmatter.title,
        memory.content,
        yamlFrontmatter,
        tags,
        memory.frontmatter.confidence || 0.8,
        (memory.frontmatter as any).last_reinforced || memory.frontmatter.modified,
        today,
        memory.frontmatter.category,
        memory.relativePath
      );

      if (!existsFts) {
        insertFts.run(
          memory.frontmatter.id,
          memory.frontmatter.title,
          tags,
          memory.content
        );
      }
    });

    tx();

    // Delete the active markdown file
    try {
      await fs.unlink(memory.filePath);
    } catch {
      // File may already be gone
    }

    return true;
  }

  /**
   * Dearchive a memory: move from archive.db → active markdown.
   * Returns the restored memory's relative path, or null on failure.
   */
  async dearchiveMemory(
    memoryId: string,
    store: GnosysStore
  ): Promise<string | null> {
    if (!this.db) return null;

    const row = this.db.prepare(
      "SELECT * FROM archived_memories WHERE id = ?"
    ).get(memoryId) as ArchivedMemory | undefined;

    if (!row) return null;

    // Restore frontmatter from stored JSON
    let frontmatter: MemoryFrontmatter;
    try {
      frontmatter = JSON.parse(row.yaml_frontmatter) as MemoryFrontmatter;
    } catch {
      // Fallback: reconstruct minimal frontmatter
      frontmatter = {
        id: row.id,
        title: row.title,
        category: row.category,
        tags: row.tags.split(" ").filter(Boolean),
        relevance: row.tags, // Use tags as relevance fallback
        author: "ai",
        authority: "imported",
        confidence: row.confidence,
        created: row.archived_date,
        modified: new Date().toISOString().split("T")[0],
        status: "active",
      };
    }

    // Reactivate
    frontmatter.status = "active";
    frontmatter.modified = new Date().toISOString().split("T")[0];

    // Write back to active markdown
    const filename = row.original_path.split("/").pop() || `${row.id}.md`;
    const relativePath = await store.writeMemory(
      row.category,
      filename,
      frontmatter,
      row.content,
      { autoCommit: false }
    );

    // Remove from archive
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM archived_memories WHERE id = ?").run(memoryId);
      this.db.prepare("DELETE FROM archive_fts WHERE id = ?").run(memoryId);
    });
    tx();

    return relativePath;
  }

  /**
   * Batch dearchive multiple memories by ID.
   * Returns array of restored relative paths.
   */
  async dearchiveBatch(
    memoryIds: string[],
    store: GnosysStore
  ): Promise<string[]> {
    const restored: string[] = [];
    for (const id of memoryIds) {
      const rp = await this.dearchiveMemory(id, store);
      if (rp) restored.push(rp);
    }
    return restored;
  }

  /**
   * Search the archive using FTS5.
   */
  searchArchive(query: string, limit: number = 20): ArchiveSearchResult[] {
    if (!this.db) return [];

    const safeQuery = query.replace(/['"]/g, "").trim();
    if (!safeQuery) return [];

    const stmt = this.db.prepare(`
      SELECT
        archive_fts.id,
        archive_fts.title,
        snippet(archive_fts, 3, '>>>', '<<<', '...', 40) as snippet,
        rank as score,
        archive_fts.tags,
        am.category
      FROM archive_fts
      JOIN archived_memories am ON archive_fts.id = am.id
      WHERE archive_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    try {
      return stmt.all(safeQuery, limit) as ArchiveSearchResult[];
    } catch {
      // FTS5 query syntax failed — try LIKE fallback
      const likeStmt = this.db.prepare(`
        SELECT
          id,
          title,
          substr(content, 1, 200) as snippet,
          0 as score,
          tags,
          category
        FROM archived_memories
        WHERE content LIKE ? OR title LIKE ? OR tags LIKE ?
        LIMIT ?
      `);
      const pattern = `%${safeQuery}%`;
      return likeStmt.all(pattern, pattern, pattern, limit) as ArchiveSearchResult[];
    }
  }

  /**
   * Get all archived memory IDs (for bulk operations).
   */
  getAllArchivedIds(): string[] {
    if (!this.db) return [];
    const rows = this.db.prepare("SELECT id FROM archived_memories").all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * Get a single archived memory by ID.
   */
  getArchivedMemory(memoryId: string): ArchivedMemory | null {
    if (!this.db) return null;
    return (this.db.prepare("SELECT * FROM archived_memories WHERE id = ?").get(memoryId) as ArchivedMemory) || null;
  }

  /**
   * Check if a memory ID exists in the archive.
   */
  isArchived(memoryId: string): boolean {
    if (!this.db) return false;
    const row = this.db.prepare("SELECT 1 FROM archived_memories WHERE id = ?").get(memoryId);
    return !!row;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db?.close();
  }
}

/**
 * Determine which active memories are eligible for archiving.
 * Criteria: days since last reinforced > maxActiveDays AND decayed confidence < minConfidence
 */
export function getArchiveEligible(
  memories: Memory[],
  config: GnosysConfig
): Memory[] {
  const now = new Date();
  const maxDays = config.archive.maxActiveDays;
  const minConf = config.archive.minConfidence;
  const DECAY_LAMBDA = 0.005;

  return memories.filter((m) => {
    if (m.frontmatter.status !== "active") return false;

    const baseConfidence = m.frontmatter.confidence || 0.8;
    const lastReinforced = (m.frontmatter as any).last_reinforced
      || m.frontmatter.modified
      || m.frontmatter.created;

    const lastDate = new Date(lastReinforced);
    const daysSince = Math.max(0, Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)));

    // Both conditions must be true: old enough AND low enough confidence
    const decayed = baseConfidence * Math.exp(-DECAY_LAMBDA * daysSince);
    return daysSince > maxDays && decayed < minConf;
  });
}
