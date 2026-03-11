/**
 * Gnosys DB — Agent-native SQLite core (v2.0).
 *
 * Single gnosys.db replaces the previous split of:
 *   .md files (source of truth) + search.db + embeddings.db + archive.db + graph.json + audit.jsonl
 *
 * 5 tables: memories, memories_fts, relationships, summaries, audit_log.
 * Schema locked by consensus (Edward + Claude + Grok, March 11, 2026).
 */

// Dynamic import — gracefully handles missing native module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  // better-sqlite3 not available — db features disabled
}

import path from "path";
import fs from "fs";
import { enableWAL } from "./lock.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface DbMemory {
  id: string;
  title: string;
  category: string;
  content: string;
  summary: string | null;
  tags: string;               // JSON array as text
  relevance: string;
  author: string;
  authority: string;
  confidence: number;
  reinforcement_count: number;
  content_hash: string;
  status: string;
  tier: string;               // "active" | "archive"
  supersedes: string | null;
  superseded_by: string | null;
  last_reinforced: string | null;
  created: string;
  modified: string;
  embedding: Buffer | null;
  source_path: string | null;
}

export interface DbRelationship {
  source_id: string;
  target_id: string;
  rel_type: string;
  label: string | null;
  confidence: number;
  created: string;
}

export interface DbSummary {
  id: string;
  scope: string;
  scope_key: string;
  content: string;
  source_ids: string;         // JSON array
  created: string;
  modified: string;
}

export interface DbAuditEntry {
  id: number;
  timestamp: string;
  operation: string;
  memory_id: string | null;
  details: string | null;     // JSON
  duration_ms: number | null;
  trace_id: string | null;
}

export interface MigrationStats {
  memoriesMigrated: number;
  archiveMigrated: number;
  relationshipsCreated: number;
  ftsBuild: boolean;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  category            TEXT NOT NULL,
  content             TEXT NOT NULL,
  summary             TEXT,
  tags                TEXT DEFAULT '',
  relevance           TEXT DEFAULT '',
  author              TEXT NOT NULL DEFAULT 'ai',
  authority           TEXT NOT NULL DEFAULT 'imported',
  confidence          REAL DEFAULT 0.8,
  reinforcement_count INTEGER DEFAULT 0,
  content_hash        TEXT NOT NULL,
  status              TEXT DEFAULT 'active',
  tier                TEXT DEFAULT 'active',
  supersedes          TEXT,
  superseded_by       TEXT,
  last_reinforced     TEXT,
  created             TEXT NOT NULL,
  modified            TEXT NOT NULL,
  embedding           BLOB,
  source_path         TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
CREATE INDEX IF NOT EXISTS idx_memories_last_reinforced ON memories(last_reinforced);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id,
  title,
  category,
  tags,
  relevance,
  content,
  summary,
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS relationships (
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  rel_type    TEXT NOT NULL DEFAULT 'references',
  label       TEXT,
  confidence  REAL DEFAULT 1.0,
  created     TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, rel_type)
);

CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(rel_type);

CREATE TABLE IF NOT EXISTS summaries (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  scope_key   TEXT NOT NULL,
  content     TEXT NOT NULL,
  source_ids  TEXT NOT NULL,
  created     TEXT NOT NULL,
  modified    TEXT NOT NULL,
  UNIQUE(scope, scope_key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL,
  operation   TEXT NOT NULL,
  memory_id   TEXT,
  details     TEXT,
  duration_ms INTEGER,
  trace_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_operation ON audit_log(operation);
CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_log(trace_id);
`;

// FTS5 sync triggers — created separately (can't use IF NOT EXISTS on triggers)
const FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(id, title, category, tags, relevance, content, summary)
  VALUES (new.id, new.title, new.category, new.tags, new.relevance, new.content, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, id, title, category, tags, relevance, content, summary)
  VALUES ('delete', old.id, old.title, old.category, old.tags, old.relevance, old.content, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, id, title, category, tags, relevance, content, summary)
  VALUES ('delete', old.id, old.title, old.category, old.tags, old.relevance, old.content, old.summary);
  INSERT INTO memories_fts(id, title, category, tags, relevance, content, summary)
  VALUES (new.id, new.title, new.category, new.tags, new.relevance, new.content, new.summary);
END;
`;

// ─── FNV-1a hash (same as embeddings.ts) ────────────────────────────────

function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ─── GnosysDB Class ─────────────────────────────────────────────────────

export class GnosysDB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any = null;
  private storePath: string;
  private available = false;

  constructor(storePath: string) {
    this.storePath = storePath;

    if (!Database) return;

    try {
      const dbPath = path.join(storePath, "gnosys.db");
      this.db = new Database(dbPath);
      enableWAL(this.db);
      this.db.pragma("foreign_keys = ON");
      this.applySchema();
      this.available = true;
    } catch {
      this.db = null;
    }
  }

  private applySchema(): void {
    // Apply main schema
    this.db.exec(SCHEMA_SQL);

    // Apply triggers (separate because of FTS5 delete syntax)
    try {
      this.db.exec(FTS_TRIGGERS_SQL);
    } catch {
      // Triggers may already exist — that's fine
    }

    // Set schema version
    const currentVersion = this.db.pragma("user_version", { simple: true });
    if (currentVersion === 0) {
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  getDbPath(): string {
    return path.join(this.storePath, "gnosys.db");
  }

  // ─── Memory CRUD ────────────────────────────────────────────────────

  insertMemory(mem: Omit<DbMemory, "embedding"> & { embedding?: Buffer | null }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memories
        (id, title, category, content, summary, tags, relevance, author, authority,
         confidence, reinforcement_count, content_hash, status, tier, supersedes,
         superseded_by, last_reinforced, created, modified, embedding, source_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      mem.id, mem.title, mem.category, mem.content, mem.summary || null,
      mem.tags, mem.relevance, mem.author, mem.authority,
      mem.confidence, mem.reinforcement_count, mem.content_hash,
      mem.status, mem.tier, mem.supersedes || null,
      mem.superseded_by || null, mem.last_reinforced || null,
      mem.created, mem.modified, mem.embedding || null, mem.source_path || null
    );
  }

  getMemory(id: string): DbMemory | null {
    return (this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as DbMemory) || null;
  }

  getActiveMemories(): DbMemory[] {
    return this.db.prepare("SELECT * FROM memories WHERE tier = 'active' AND status = 'active'").all() as DbMemory[];
  }

  getAllMemories(): DbMemory[] {
    return this.db.prepare("SELECT * FROM memories").all() as DbMemory[];
  }

  getMemoriesByTier(tier: string): DbMemory[] {
    return this.db.prepare("SELECT * FROM memories WHERE tier = ?").all(tier) as DbMemory[];
  }

  getMemoriesByCategory(category: string): DbMemory[] {
    return this.db.prepare("SELECT * FROM memories WHERE category = ? AND tier = 'active'").all(category) as DbMemory[];
  }

  updateMemory(id: string, updates: Partial<DbMemory>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (key === "id") continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }

    if (fields.length === 0) return;
    values.push(id);

    this.db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteMemory(id: string): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  getMemoryCount(): { active: number; archived: number; total: number } {
    const active = (this.db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE tier = 'active'").get() as { cnt: number }).cnt;
    const archived = (this.db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE tier = 'archive'").get() as { cnt: number }).cnt;
    return { active, archived, total: active + archived };
  }

  getCategories(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT category FROM memories WHERE tier = 'active' ORDER BY category").all() as { category: string }[];
    return rows.map((r) => r.category);
  }

  // ─── FTS5 Search ────────────────────────────────────────────────────

  searchFts(query: string, limit: number = 20): Array<{ id: string; title: string; snippet: string; rank: number }> {
    const safeQuery = query.replace(/['"]/g, "").trim();
    if (!safeQuery) return [];

    try {
      return this.db.prepare(`
        SELECT id, title,
               snippet(memories_fts, 5, '>>>', '<<<', '...', 40) as snippet,
               rank
        FROM memories_fts
        WHERE memories_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(safeQuery, limit);
    } catch {
      // FTS5 syntax error — fallback to LIKE
      const pattern = `%${safeQuery}%`;
      return this.db.prepare(`
        SELECT id, title, substr(content, 1, 200) as snippet, 0 as rank
        FROM memories WHERE content LIKE ? OR title LIKE ? OR tags LIKE ?
        LIMIT ?
      `).all(pattern, pattern, pattern, limit);
    }
  }

  discoverFts(query: string, limit: number = 20): Array<{ id: string; title: string; relevance: string; rank: number }> {
    const safeQuery = query.replace(/['"]/g, "").trim();
    if (!safeQuery) return [];

    try {
      const colQuery = `{relevance title tags} : ${safeQuery}`;
      const results = this.db.prepare(`
        SELECT id, title, relevance, rank
        FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?
      `).all(colQuery, limit);
      if (results.length > 0) return results;

      return this.db.prepare(`
        SELECT id, title, relevance, rank
        FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?
      `).all(safeQuery, limit);
    } catch {
      try {
        return this.db.prepare(`
          SELECT id, title, relevance, rank
          FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?
        `).all(safeQuery, limit);
      } catch {
        return [];
      }
    }
  }

  // ─── Relationships ──────────────────────────────────────────────────

  insertRelationship(rel: DbRelationship): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO relationships (source_id, target_id, rel_type, label, confidence, created)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(rel.source_id, rel.target_id, rel.rel_type, rel.label, rel.confidence, rel.created);
  }

  getRelationshipsFrom(id: string): DbRelationship[] {
    return this.db.prepare("SELECT * FROM relationships WHERE source_id = ?").all(id) as DbRelationship[];
  }

  getRelationshipsTo(id: string): DbRelationship[] {
    return this.db.prepare("SELECT * FROM relationships WHERE target_id = ?").all(id) as DbRelationship[];
  }

  // ─── Summaries ──────────────────────────────────────────────────────

  upsertSummary(summary: DbSummary): void {
    this.db.prepare(`
      INSERT INTO summaries (id, scope, scope_key, content, source_ids, created, modified)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, scope_key) DO UPDATE SET
        content = excluded.content,
        source_ids = excluded.source_ids,
        modified = excluded.modified
    `).run(summary.id, summary.scope, summary.scope_key, summary.content, summary.source_ids, summary.created, summary.modified);
  }

  getSummary(scope: string, scopeKey: string): DbSummary | null {
    return (this.db.prepare("SELECT * FROM summaries WHERE scope = ? AND scope_key = ?").get(scope, scopeKey) as DbSummary) || null;
  }

  getAllSummaries(): DbSummary[] {
    return this.db.prepare("SELECT * FROM summaries").all() as DbSummary[];
  }

  // ─── Audit ──────────────────────────────────────────────────────────

  logAudit(entry: Omit<DbAuditEntry, "id">): void {
    this.db.prepare(`
      INSERT INTO audit_log (timestamp, operation, memory_id, details, duration_ms, trace_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entry.timestamp, entry.operation, entry.memory_id, entry.details, entry.duration_ms, entry.trace_id);
  }

  // ─── Embeddings ─────────────────────────────────────────────────────

  updateEmbedding(id: string, embedding: Buffer): void {
    this.db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(embedding, id);
  }

  getEmbedding(id: string): Buffer | null {
    const row = this.db.prepare("SELECT embedding FROM memories WHERE id = ?").get(id) as { embedding: Buffer | null } | undefined;
    return row?.embedding || null;
  }

  getAllEmbeddings(): Array<{ id: string; embedding: Buffer }> {
    return this.db.prepare("SELECT id, embedding FROM memories WHERE embedding IS NOT NULL").all() as Array<{ id: string; embedding: Buffer }>;
  }

  // ─── Transactions ───────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  close(): void {
    this.db?.close();
  }

  // ─── Migration Status ───────────────────────────────────────────────

  isMigrated(): boolean {
    if (!this.available) return false;
    const count = (this.db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number }).cnt;
    return count > 0;
  }

  getSchemaVersion(): number {
    if (!this.available) return 0;
    return this.db.pragma("user_version", { simple: true }) as number;
  }
}

// ─── Migration Helper ─────────────────────────────────────────────────

export { fnv1a };
