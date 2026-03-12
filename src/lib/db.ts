/**
 * Gnosys DB — Agent-native SQLite core.
 *
 * v2.0: Single gnosys.db per project (.gnosys/gnosys.db)
 * v3.0: Central gnosys.db at ~/.gnosys/gnosys.db with project_id + scope columns
 *
 * 5 tables: memories, memories_fts, relationships, summaries, audit_log.
 * + projects table (v3.0) for project identity registry.
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
  // v3.0: Centralized Brain
  project_id: string | null;  // UUID from gnosys.json — NULL for user/global
  scope: string;              // "project" | "user" | "global"
}

/** v3.0: Project identity stored in central DB */
export interface DbProject {
  id: string;                  // UUID v4
  name: string;                // Human-readable project name
  working_directory: string;   // Absolute path
  user: string;                // Username
  agent_rules_target: string | null; // Path to generated rules file
  obsidian_vault: string | null;     // Obsidian export path
  created: string;
  modified: string;
}

export type MemoryScope = "project" | "user" | "global";

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

const SCHEMA_VERSION = 2;

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
  source_path         TEXT,
  project_id          TEXT,
  scope               TEXT DEFAULT 'project' CHECK(scope IN ('project','user','global'))
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
CREATE INDEX IF NOT EXISTS idx_memories_last_reinforced ON memories(last_reinforced);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);

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

CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  working_directory   TEXT NOT NULL UNIQUE,
  user                TEXT NOT NULL,
  agent_rules_target  TEXT,
  obsidian_vault      TEXT,
  created             TEXT NOT NULL,
  modified            TEXT NOT NULL
);
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
  private dbFilePath: string;

  /**
   * Get the central DB directory (~/.gnosys/).
   * Creates it if it doesn't exist.
   */
  static getCentralDbDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    return path.join(home, ".gnosys");
  }

  /**
   * Get the central DB file path (~/.gnosys/gnosys.db).
   */
  static getCentralDbPath(): string {
    return path.join(GnosysDB.getCentralDbDir(), "gnosys.db");
  }

  /**
   * Open the central DB at ~/.gnosys/gnosys.db.
   * Creates ~/.gnosys/ directory if needed.
   */
  static openCentral(): GnosysDB {
    const dir = GnosysDB.getCentralDbDir();
    fs.mkdirSync(dir, { recursive: true });
    return new GnosysDB(dir);
  }

  constructor(storePath: string) {
    this.storePath = storePath;
    this.dbFilePath = path.join(storePath, "gnosys.db");

    if (!Database) return;

    try {
      fs.mkdirSync(storePath, { recursive: true });
      this.db = new Database(this.dbFilePath);
      enableWAL(this.db);
      this.db.pragma("foreign_keys = ON");
      this.applySchema();
      this.available = true;
    } catch {
      this.db = null;
    }
  }

  /**
   * Create a backup of the database file.
   * Returns the backup file path.
   */
  backup(backupDir?: string): string {
    if (!this.available) throw new Error("Database not available");
    const dir = backupDir || this.storePath;
    fs.mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = path.join(dir, `gnosys-backup-${timestamp}.db`);
    this.db.backup(backupPath);
    return backupPath;
  }

  /**
   * Restore from a backup file. Closes current DB, copies backup over, re-opens.
   */
  static restore(backupPath: string, targetDir?: string): GnosysDB {
    const dir = targetDir || GnosysDB.getCentralDbDir();
    const targetPath = path.join(dir, "gnosys.db");

    // Validate backup file exists
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }

    // Copy backup over
    fs.copyFileSync(backupPath, targetPath);

    // Re-open
    return new GnosysDB(dir);
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

    // Schema migration: v1 → v2 (add project_id, scope, projects table)
    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (currentVersion < SCHEMA_VERSION) {
      this.migrateSchema(currentVersion);
    }
  }

  /**
   * Incremental schema migration.
   * Each version bump adds columns/tables without dropping existing data.
   */
  private migrateSchema(fromVersion: number): void {
    if (fromVersion < 2) {
      // v1 → v2: Add project_id and scope columns to memories
      try {
        this.db.exec("ALTER TABLE memories ADD COLUMN project_id TEXT");
      } catch {
        // Column already exists — fine
      }
      try {
        this.db.exec("ALTER TABLE memories ADD COLUMN scope TEXT DEFAULT 'project'");
      } catch {
        // Column already exists — fine
      }

      // Create indexes for new columns
      try {
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)");
      } catch {
        // Indexes may already exist
      }

      // Create projects table
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS projects (
            id                  TEXT PRIMARY KEY,
            name                TEXT NOT NULL,
            working_directory   TEXT NOT NULL UNIQUE,
            user                TEXT NOT NULL,
            agent_rules_target  TEXT,
            obsidian_vault      TEXT,
            created             TEXT NOT NULL,
            modified            TEXT NOT NULL
          )
        `);
      } catch {
        // Table may already exist
      }
    }

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  isAvailable(): boolean {
    return this.available;
  }

  getDbPath(): string {
    return this.dbFilePath;
  }

  getStorePath(): string {
    return this.storePath;
  }

  // ─── Memory CRUD ────────────────────────────────────────────────────

  insertMemory(mem: Omit<DbMemory, "embedding"> & { embedding?: Buffer | null }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memories
        (id, title, category, content, summary, tags, relevance, author, authority,
         confidence, reinforcement_count, content_hash, status, tier, supersedes,
         superseded_by, last_reinforced, created, modified, embedding, source_path,
         project_id, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      mem.id, mem.title, mem.category, mem.content, mem.summary || null,
      mem.tags, mem.relevance, mem.author, mem.authority,
      mem.confidence, mem.reinforcement_count, mem.content_hash,
      mem.status, mem.tier, mem.supersedes || null,
      mem.superseded_by || null, mem.last_reinforced || null,
      mem.created, mem.modified, mem.embedding || null, mem.source_path || null,
      mem.project_id || null, mem.scope || "project"
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

  // ─── Scoped Queries (v3.0) ──────────────────────────────────────────

  /**
   * Get active memories scoped to a specific project.
   */
  getMemoriesByProject(projectId: string): DbMemory[] {
    return this.db.prepare(
      "SELECT * FROM memories WHERE project_id = ? AND tier = 'active' AND status = 'active'"
    ).all(projectId) as DbMemory[];
  }

  /**
   * Get memories by scope (project, user, global).
   */
  getMemoriesByScope(scope: MemoryScope): DbMemory[] {
    return this.db.prepare(
      "SELECT * FROM memories WHERE scope = ? AND tier = 'active' AND status = 'active'"
    ).all(scope) as DbMemory[];
  }

  // ─── Project Identity (v3.0) ──────────────────────────────────────

  insertProject(project: DbProject): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO projects
        (id, name, working_directory, user, agent_rules_target, obsidian_vault, created, modified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id, project.name, project.working_directory, project.user,
      project.agent_rules_target || null, project.obsidian_vault || null,
      project.created, project.modified
    );
  }

  getProject(id: string): DbProject | null {
    return (this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as DbProject) || null;
  }

  getProjectByDirectory(dir: string): DbProject | null {
    return (this.db.prepare("SELECT * FROM projects WHERE working_directory = ?").get(dir) as DbProject) || null;
  }

  getAllProjects(): DbProject[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY name").all() as DbProject[];
  }

  updateProject(id: string, updates: Partial<DbProject>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === "id") continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
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
