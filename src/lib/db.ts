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
import { getGnosysHome as getGnosysHomeImpl, getCentralDbPath as getCentralDbPathImpl } from "./paths.js";
import { ulid } from "ulidx";

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
  // v5.0: Multimodal source tracking
  source_file: string | null;       // Original file name (e.g., "report.pdf")
  source_page: string | null;       // Page/slide number within source
  source_timerange: string | null;  // Timestamp range for audio/video (e.g., "00:01:30-00:02:45")
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

const SCHEMA_VERSION = 3;

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
  source_file         TEXT,
  source_page         TEXT,
  source_timerange    TEXT,
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

CREATE TABLE IF NOT EXISTS gnosys_meta (
  key                 TEXT PRIMARY KEY,
  value               TEXT NOT NULL,
  updated             TEXT NOT NULL
);

-- v5.3.0: remote sync support

CREATE TABLE IF NOT EXISTS pending_sync (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   TEXT NOT NULL,
  operation   TEXT NOT NULL,
  timestamp   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_pending_sync_status ON pending_sync(status);
CREATE INDEX IF NOT EXISTS idx_pending_sync_memory ON pending_sync(memory_id);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  memory_id        TEXT PRIMARY KEY,
  detected_at      TEXT NOT NULL,
  local_modified   TEXT NOT NULL,
  remote_modified  TEXT NOT NULL,
  local_snapshot   TEXT,
  remote_snapshot  TEXT,
  status           TEXT NOT NULL DEFAULT 'unresolved'
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON sync_conflicts(status);
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

// ─── Column whitelists (prevent SQL injection via dynamic keys) ──────────

const MEMORY_COLUMNS = new Set([
  "title", "category", "content", "summary", "tags", "relevance",
  "author", "authority", "confidence", "reinforcement_count", "content_hash",
  "status", "tier", "supersedes", "superseded_by", "last_reinforced",
  "created", "modified", "embedding", "source_path",
  "source_file", "source_page", "source_timerange",
  "project_id", "scope",
]);

const PROJECT_COLUMNS = new Set([
  "name", "working_directory", "user", "agent_rules_target",
  "obsidian_vault", "created", "modified",
]);

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
   * Get the gnosys home directory. Delegates to the canonical helper in
   * paths.ts — kept here for callers that already have a GnosysDB import.
   * See `getGnosysHome()` in `./paths.js` for the full contract.
   */
  static getGnosysHome(): string {
    return getGnosysHomeImpl();
  }

  /** @deprecated Use getGnosysHome() — kept temporarily for backward compat. */
  static getCentralDbDir(): string {
    return getGnosysHomeImpl();
  }

  /**
   * Get the central DB file path. Delegates to paths.ts.
   */
  static getCentralDbPath(): string {
    return getCentralDbPathImpl();
  }

  /**
   * Open the central DB.
   *
   * v5.4.1 (per deci-037): If a remote NAS is configured AND reachable,
   * this returns the REMOTE DB so reads see the latest state and writes
   * go directly to the source of truth. Falls back to local cache when
   * remote is unreachable (e.g. NAS offline, VPN/Tailscale down).
   *
   * For sync operations (push/pull/sync/migrate) and remote configuration,
   * use `openLocal()` instead — those operations need explicit local DB
   * access so they can move data between local and remote.
   *
   * Force local-only mode by setting `GNOSYS_LOCAL_ONLY=1` (used by tests
   * and offline-first workflows).
   */
  static openCentral(): GnosysDB {
    if (process.env.GNOSYS_LOCAL_ONLY === "1") {
      return GnosysDB.openLocal();
    }

    const localDb = GnosysDB.openLocal();

    // Check if remote is configured. If not, we're done — return local.
    let remotePath: string | null = null;
    try {
      if (localDb.isAvailable()) {
        remotePath = localDb.getMeta("remote_path");
      }
    } catch {
      // Local DB unusable — return it anyway; caller will surface error
      return localDb;
    }
    if (!remotePath) {
      return localDb;
    }

    // Reachability probe — fast fs.access on the file. ~1ms when mounted,
    // fails fast when not. Avoids hanging on unmounted SMB shares.
    const remoteDbFile = path.join(remotePath, "gnosys.db");
    let remoteReachable = false;
    try {
      fs.accessSync(remoteDbFile, fs.constants.R_OK);
      remoteReachable = true;
    } catch {
      // Remote not reachable
    }

    if (!remoteReachable) {
      // Quiet fallback notice on stderr — visible to humans, doesn't pollute
      // stdout that scripts/agents are piping. Only emitted when remote is
      // CONFIGURED but unreachable (the user expected it to work).
      process.stderr.write(
        `gnosys: remote unreachable (${remotePath}), using local cache\n`
      );
      return localDb;
    }

    // Remote is reachable — open it and return. Close local first since we
    // don't need it during this operation.
    try {
      localDb.close();
    } catch {
      // ignore
    }
    return new GnosysDB(remotePath);
  }

  /**
   * Open the local central DB explicitly (no remote routing). Used by sync
   * operations, remote configuration, and offline-first commands.
   */
  static openLocal(): GnosysDB {
    const dir = GnosysDB.getGnosysHome();
    fs.mkdirSync(dir, { recursive: true });
    return new GnosysDB(dir);
  }

  constructor(storePath: string, opts?: { retries?: number; retryDelayMs?: number }) {
    this.storePath = storePath;
    this.dbFilePath = path.join(storePath, "gnosys.db");

    if (!Database) return;

    const maxRetries = opts?.retries ?? 3;
    const retryDelay = opts?.retryDelayMs ?? 500;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        fs.mkdirSync(storePath, { recursive: true });
        this.db = new Database(this.dbFilePath);
        enableWAL(this.db);
        this.db.pragma("foreign_keys = ON");
        // Longer busy timeout for network shares (10s)
        this.db.pragma("busy_timeout = 10000");
        this.applySchema();
        this.available = true;
        return; // Success
      } catch (err) {
        this.db = null;
        if (attempt < maxRetries) {
          // Synchronous delay for constructor (network share retry)
          const start = Date.now();
          while (Date.now() - start < retryDelay) { /* spin wait */ }
        }
        // Last attempt fails silently — db stays unavailable
      }
    }
  }

  /**
   * Create a backup of the database file.
   * Returns the backup file path.
   */
  async backup(backupDir?: string): Promise<string> {
    if (!this.available) throw new Error("Database not available");
    const dir = backupDir || this.storePath;
    fs.mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = path.join(dir, `gnosys-backup-${timestamp}.db`);
    await this.db.backup(backupPath);
    return backupPath;
  }

  /**
   * Detect SQLite corruption-related errors. Useful for distinguishing
   * "the DB file is broken" from transient errors. Returns true for:
   *   - SQLITE_CORRUPT (database disk image is malformed)
   *   - SQLITE_NOTADB (file is not a database)
   *   - "out of memory" during page read (often caused by truncated WAL)
   */
  static isCorruptionError(err: unknown): boolean {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    return (
      code === "SQLITE_CORRUPT" ||
      code === "SQLITE_NOTADB" ||
      /database disk image is malformed/i.test(msg) ||
      /file is not a database/i.test(msg)
    );
  }

  /**
   * Render user-facing recovery instructions for DB corruption.
   * Used by both CLI error paths and MCP error responses.
   */
  static corruptionRecoveryInstructions(): string {
    return [
      "Database disk image is malformed.",
      "",
      "Quick recovery:",
      "  1. Close any running gnosys processes (mcp servers, agents).",
      "  2. Force a WAL checkpoint:",
      "       sqlite3 ~/.gnosys/gnosys.db 'PRAGMA wal_checkpoint(TRUNCATE);'",
      "  3. If the error persists, attempt SQLite recovery:",
      "       cp ~/.gnosys/gnosys.db ~/.gnosys/gnosys.db.backup",
      "       sqlite3 ~/.gnosys/gnosys.db '.recover' | sqlite3 ~/.gnosys/gnosys-repaired.db",
      "       mv ~/.gnosys/gnosys.db ~/.gnosys/gnosys.db.broken",
      "       mv ~/.gnosys/gnosys-repaired.db ~/.gnosys/gnosys.db",
      "  4. If you have a healthy remote (NAS) sync, you can also restore from there:",
      "       rm ~/.gnosys/gnosys.db",
      "       gnosys remote pull",
    ].join("\n");
  }

  /**
   * Close the current connection and reopen. Used to recover from stale
   * file handles after a WAL checkpoint or remount.
   */
  reopen(): void {
    try {
      this.db?.close();
    } catch {
      // ignore — was already in a bad state
    }
    this.db = null;
    this.available = false;
    if (!Database) return;
    try {
      this.db = new Database(this.dbFilePath);
      enableWAL(this.db);
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 10000");
      this.available = true;
    } catch {
      // reopen failed — leave unavailable; caller surfaces error
    }
  }

  /**
   * Execute a DB operation with automatic recovery from stale-handle errors.
   *
   * SQLITE_CORRUPT ("database disk image is malformed") can happen when a
   * long-lived handle (e.g. an MCP server process) sees stale pages after
   * concurrent writes from another process (`gnosys setup`, sync layer, etc.)
   * truncated the WAL or rolled the schema. The DB file itself is fine —
   * just our cached page view is out of date.
   *
   * Strategy: catch the error, close + reopen the handle, retry once. If it
   * still fails after reopen, rethrow — that's a real corruption case.
   *
   * Used internally by write methods that the MCP server calls long-term.
   * Read methods are also wrapped because reads against stale pages can
   * surface the same error.
   */
  private withRecovery<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      const errAny = err as { code?: string; message?: string };
      const isCorrupt =
        errAny?.code === "SQLITE_CORRUPT" ||
        /database disk image is malformed/i.test(errAny?.message ?? "");
      if (!isCorrupt) throw err;

      // One-shot recovery: reopen and retry. If the reopen itself fails or
      // the retry surfaces the same error, that's a real corruption case —
      // surface it loudly.
      this.reopen();
      if (!this.available) {
        throw new Error(
          "Gnosys DB unrecoverable after reopen. The underlying file may be corrupted. " +
          "Run 'gnosys doctor' for diagnostics; restore from a backup if needed.",
        );
      }
      return fn();
    }
  }

  /**
   * Restore from a backup file. Closes current DB, copies backup over, re-opens.
   */
  static restore(backupPath: string, targetDir?: string): GnosysDB {
    const dir = targetDir || GnosysDB.getGnosysHome();
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

    if (fromVersion < 3) {
      // v2 → v3: Add multimodal source columns to memories
      try {
        this.db.exec("ALTER TABLE memories ADD COLUMN source_file TEXT");
      } catch {
        // Column already exists — fine
      }
      try {
        this.db.exec("ALTER TABLE memories ADD COLUMN source_page TEXT");
      } catch {
        // Column already exists — fine
      }
      try {
        this.db.exec("ALTER TABLE memories ADD COLUMN source_timerange TEXT");
      } catch {
        // Column already exists — fine
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

  insertMemory(mem: Omit<DbMemory, "embedding" | "source_file" | "source_page" | "source_timerange"> & { embedding?: Buffer | null; source_file?: string | null; source_page?: string | null; source_timerange?: string | null }): void {
    return this.withRecovery(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO memories
          (id, title, category, content, summary, tags, relevance, author, authority,
           confidence, reinforcement_count, content_hash, status, tier, supersedes,
           superseded_by, last_reinforced, created, modified, embedding, source_path,
           source_file, source_page, source_timerange,
           project_id, scope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        mem.id, mem.title, mem.category, mem.content, mem.summary || null,
        mem.tags, mem.relevance, mem.author, mem.authority,
        mem.confidence, mem.reinforcement_count, mem.content_hash,
        mem.status, mem.tier, mem.supersedes || null,
        mem.superseded_by || null, mem.last_reinforced || null,
        mem.created, mem.modified, mem.embedding || null, mem.source_path || null,
        mem.source_file || null, mem.source_page || null, mem.source_timerange || null,
        mem.project_id || null, mem.scope || "project"
      );
    });
  }

  getMemory(id: string): DbMemory | null {
    return this.withRecovery(() =>
      (this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as DbMemory) || null,
    );
  }

  getActiveMemories(): DbMemory[] {
    return this.withRecovery(() =>
      this.db.prepare("SELECT * FROM memories WHERE tier = 'active' AND status = 'active'").all() as DbMemory[],
    );
  }

  getAllMemories(): DbMemory[] {
    return this.withRecovery(() => this.db.prepare("SELECT * FROM memories").all() as DbMemory[]);
  }

  /**
   * Cheap variant: just id + modified, in one shot. Used by remote sync status
   * to compute pending push/pull counts without paying for full row hydration
   * over SMB. Returns rows changed strictly after `sinceIso`.
   */
  getIdsModifiedSince(sinceIso: string): Array<{ id: string; modified: string }> {
    return this.withRecovery(() =>
      this.db
        .prepare("SELECT id, modified FROM memories WHERE modified > ? OR created > ?")
        .all(sinceIso, sinceIso) as Array<{ id: string; modified: string }>,
    );
  }

  /**
   * Configure a one-shot SQLite busy_timeout (in milliseconds) on this
   * connection. Default at open time is 10s; for short-deadline operations
   * like `gnosys status --remote` we drop it to ~3s so a held write lock on
   * the NAS fails fast with SQLITE_BUSY instead of hanging the CLI.
   *
   * The caller should restore the prior value with `setBusyTimeout(10000)`
   * once the deadline-bounded operation is done.
   */
  setBusyTimeout(ms: number): void {
    if (!this.db) return;
    this.db.pragma(`busy_timeout = ${Math.max(0, Math.floor(ms))}`);
  }

  getMemoriesByTier(tier: string): DbMemory[] {
    return this.db.prepare("SELECT * FROM memories WHERE tier = ?").all(tier) as DbMemory[];
  }

  getMemoriesByCategory(category: string): DbMemory[] {
    return this.db.prepare("SELECT * FROM memories WHERE category = ? AND tier = 'active'").all(category) as DbMemory[];
  }

  getRelationshipsForMemoryIds(ids: string[]): DbRelationship[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM relationships WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      )
      .all(...ids, ...ids) as DbRelationship[];
  }

  getAuditEntriesByProject(projectId: string): DbAuditEntry[] {
    return this.db
      .prepare(
        "SELECT * FROM audit_log WHERE memory_id IN (SELECT id FROM memories WHERE project_id = ?) ORDER BY id",
      )
      .all(projectId) as DbAuditEntry[];
  }

  updateMemory(id: string, updates: Partial<DbMemory>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (key === "id") continue;
      if (!MEMORY_COLUMNS.has(key)) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }

    if (fields.length === 0) return;
    values.push(id);

    const sql = `UPDATE memories SET ${fields.join(", ")} WHERE id = ?`;

    try {
      this.db.prepare(sql).run(...values);
    } catch {
      // FTS5 update trigger may fail if INSERT OR REPLACE left FTS inconsistent.
      // Workaround: drop the trigger, update manually, rebuild FTS entry.
      this.db.exec("DROP TRIGGER IF EXISTS memories_fts_au");
      this.db.prepare(sql).run(...values);

      // Recreate trigger
      try {
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, id, title, category, tags, relevance, content, summary)
            VALUES ('delete', old.id, old.title, old.category, old.tags, old.relevance, old.content, old.summary);
            INSERT INTO memories_fts(id, title, category, tags, relevance, content, summary)
            VALUES (new.id, new.title, new.category, new.tags, new.relevance, new.content, new.summary);
          END;
        `);
      } catch {
        // Trigger recreation failed — not critical
      }
    }

    // Manually sync FTS: remove old entry, insert updated entry (reliable for standalone FTS5)
    try {
      this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    } catch {
      // Old FTS entry may not exist — that's OK
    }

    const newMem = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as DbMemory | undefined;
    if (newMem) {
      try {
        this.db.prepare(
          "INSERT INTO memories_fts(id, title, category, tags, relevance, content, summary) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(newMem.id, newMem.title, newMem.category, newMem.tags, newMem.relevance, newMem.content, newMem.summary);
      } catch {
        // FTS insert may fail — not critical
      }
    }
  }

  deleteMemory(id: string): void {
    // FTS5 delete trigger may fail if INSERT OR REPLACE left FTS inconsistent.
    try {
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    } catch {
      // FTS trigger failed — drop trigger, delete without it
      this.db.exec("DROP TRIGGER IF EXISTS memories_fts_ad");
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      // Recreate trigger
      try {
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, id, title, category, tags, relevance, content, summary)
            VALUES ('delete', old.id, old.title, old.category, old.tags, old.relevance, old.content, old.summary);
          END;
        `);
      } catch {
        // Trigger recreation failed — not critical
      }
    }

    // Ensure FTS entry is also removed (direct DELETE is reliable for standalone FTS5)
    try {
      this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    } catch {
      // FTS entry may not exist — that's OK
    }
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
  getMemoriesByProject(projectId: string, includeArchived = false): DbMemory[] {
    const sql = includeArchived
      ? "SELECT * FROM memories WHERE project_id = ?"
      : "SELECT * FROM memories WHERE project_id = ? AND tier = 'active' AND status = 'active'";
    return this.db.prepare(sql).all(projectId) as DbMemory[];
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
    return this.withRecovery(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO projects
          (id, name, working_directory, user, agent_rules_target, obsidian_vault, created, modified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project.id, project.name, project.working_directory, project.user,
        project.agent_rules_target || null, project.obsidian_vault || null,
        project.created, project.modified,
      );
    });
  }

  getProject(id: string): DbProject | null {
    return this.withRecovery(() =>
      (this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as DbProject) || null,
    );
  }

  getProjectByDirectory(dir: string): DbProject | null {
    return this.withRecovery(() =>
      (this.db.prepare("SELECT * FROM projects WHERE working_directory = ?").get(dir) as DbProject) || null,
    );
  }

  getAllProjects(): DbProject[] {
    return this.withRecovery(() =>
      this.db.prepare("SELECT * FROM projects ORDER BY name").all() as DbProject[],
    );
  }

  updateProject(id: string, updates: Partial<DbProject>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === "id") continue;
      if (!PROJECT_COLUMNS.has(key)) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteProject(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  /**
   * Reassign all memories from one project to another.
   * Returns the number of memories updated.
   */
  reassignMemories(fromProjectId: string, toProjectId: string): number {
    const result = this.db
      .prepare("UPDATE memories SET project_id = ? WHERE project_id = ?")
      .run(toProjectId, fromProjectId);
    return result.changes;
  }

  /**
   * Generate the next sequential ID for a category.
   * Format (v5.4.1+): first 4 chars of category + dash + ULID
   * (e.g., "deci-01HZK3MQXYZABCDEFGHJKMNPQR").
   *
   * ULIDs are time-sortable (first 10 chars encode the timestamp), globally
   * unique without coordination, and support concurrent writes from multiple
   * machines and multiple agents on one machine without ID collisions.
   *
   * Existing memories with `prefix-NNN` IDs are unaffected — those IDs remain
   * unchanged. Only new IDs use the ULID format.
   *
   * The `projectId` parameter is accepted for API compatibility but no longer
   * used for ID generation (ULIDs don't need project scoping for uniqueness).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getNextId(category: string, projectId?: string): string {
    const prefix = category.substring(0, 4);
    return `${prefix}-${ulid()}`;
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

  discoverFts(
    query: string,
    limit: number = 20,
  ): Array<{ id: string; title: string; relevance: string; rank: number; project_id: string | null }> {
    const safeQuery = query.replace(/['"]/g, "").trim();
    if (!safeQuery) return [];

    // v5.7.1 (#14): join `memories` so callers can render project-prefixed IDs.
    const select = `
      SELECT m.id AS id, m.title AS title, m.relevance AS relevance, fts.rank AS rank, m.project_id AS project_id
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.id
      WHERE memories_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `;

    try {
      const colQuery = `{relevance title tags} : ${safeQuery}`;
      const results = this.db.prepare(select).all(colQuery, limit) as Array<{
        id: string; title: string; relevance: string; rank: number; project_id: string | null;
      }>;
      if (results.length > 0) return results;

      return this.db.prepare(select).all(safeQuery, limit) as Array<{
        id: string; title: string; relevance: string; rank: number; project_id: string | null;
      }>;
    } catch {
      try {
        return this.db.prepare(select).all(safeQuery, limit) as Array<{
          id: string; title: string; relevance: string; rank: number; project_id: string | null;
        }>;
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
    return this.withRecovery(() => {
      this.db.prepare(`
        INSERT INTO audit_log (timestamp, operation, memory_id, details, duration_ms, trace_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entry.timestamp, entry.operation, entry.memory_id, entry.details, entry.duration_ms, entry.trace_id);
    });
  }

  getAuditLog(memoryId: string, limit: number = 20): DbAuditEntry[] {
    return this.withRecovery(() =>
      this.db.prepare(
        "SELECT * FROM audit_log WHERE memory_id = ? ORDER BY timestamp DESC LIMIT ?",
      ).all(memoryId, limit) as DbAuditEntry[],
    );
  }

  /**
   * Get audit entries newer than a given timestamp. Used by remote sync to
   * push/pull audit_log incrementally. Returns oldest-first so order is
   * preserved across machines.
   */
  getAuditEntriesAfter(sinceIso: string, limit?: number): DbAuditEntry[] {
    return this.withRecovery(() => {
      const cap = limit ? ` LIMIT ${Math.max(1, Math.floor(limit))}` : "";
      return this.db
        .prepare(`SELECT * FROM audit_log WHERE timestamp > ? ORDER BY timestamp ASC${cap}`)
        .all(sinceIso) as DbAuditEntry[];
    });
  }

  /**
   * Get the most recent audit timestamp seen in this DB. Used as a high-water
   * mark for sync: "push entries newer than the most recent timestamp the
   * remote has already seen". Returns null when the table is empty.
   */
  getLatestAuditTimestamp(): string | null {
    return this.withRecovery(() => {
      const row = this.db
        .prepare("SELECT timestamp FROM audit_log ORDER BY timestamp DESC LIMIT 1")
        .get() as { timestamp: string } | undefined;
      return row?.timestamp ?? null;
    });
  }

  /**
   * Query audit entries with optional filters. Returns newest first.
   * Used by `gnosys audit` and `gnosys doctor` reports.
   */
  queryAuditLog(opts: { sinceIso?: string; operation?: string; limit?: number } = {}): DbAuditEntry[] {
    return this.withRecovery(() => {
      const conditions: string[] = [];
      const params: Array<string | number> = [];
      if (opts.sinceIso) {
        conditions.push("timestamp >= ?");
        params.push(opts.sinceIso);
      }
      if (opts.operation) {
        conditions.push("operation = ?");
        params.push(opts.operation);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = opts.limit ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}` : "";
      return this.db
        .prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC${limit}`)
        .all(...params) as DbAuditEntry[];
    });
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

  getEmbeddingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE embedding IS NOT NULL").get() as { cnt: number };
    return row.cnt;
  }

  // ─── Transactions ───────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ─── Metadata ──────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    if (!this.available) return null;
    try {
      const row = this.db.prepare("SELECT value FROM gnosys_meta WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null; // table may not exist in older DBs
    }
  }

  setMeta(key: string, value: string): void {
    if (!this.available) return;
    try {
      this.db.prepare(
        "INSERT INTO gnosys_meta (key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated"
      ).run(key, value, new Date().toISOString());
    } catch {
      // table may not exist — create it and retry
      try {
        this.db.exec("CREATE TABLE IF NOT EXISTS gnosys_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated TEXT NOT NULL)");
        this.db.prepare(
          "INSERT INTO gnosys_meta (key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated"
        ).run(key, value, new Date().toISOString());
      } catch {
        // give up silently
      }
    }
  }

  // ─── Dream state (v5.4.2) ───────────────────────────────────────────

  /**
   * Get the machine ID designated to run dream cycles. Stored in gnosys_meta
   * under `dream_machine_id`. Returns null if no machine is designated (dream
   * is effectively disabled across the fleet).
   */
  getDreamMachineId(): string | null {
    return this.getMeta("dream_machine_id");
  }

  /** Designate a machine for dream cycles. */
  setDreamMachineId(machineId: string): void {
    this.setMeta("dream_machine_id", machineId);
  }

  /** Clear dream designation. No machine will dream. */
  clearDreamMachineId(): void {
    try {
      this.db.prepare("DELETE FROM gnosys_meta WHERE key = ?").run("dream_machine_id");
    } catch {
      // ignore
    }
  }

  /**
   * Get the count of consecutive dream provider failures. Reset to 0 after a
   * successful LLM call. Used to drive Layer 4 desktop notifications when
   * the threshold is crossed.
   */
  getDreamConsecutiveFailures(): number {
    const v = this.getMeta("dream_consecutive_failures");
    return v ? parseInt(v, 10) || 0 : 0;
  }

  /** Increment and return the new count. */
  incrementDreamConsecutiveFailures(): number {
    const next = this.getDreamConsecutiveFailures() + 1;
    this.setMeta("dream_consecutive_failures", String(next));
    return next;
  }

  /** Reset to 0 (call after a successful LLM round in a dream cycle). */
  resetDreamConsecutiveFailures(): void {
    this.setMeta("dream_consecutive_failures", "0");
  }

  /**
   * Get the most recent dream runs for `gnosys dream log` and dashboard.
   * Each row corresponds to a `dream_complete` audit entry. Includes the
   * matching `dream_start` timestamp and counts of per-action sub-entries.
   */
  getRecentDreamRuns(limit: number = 20, opts: { failuresOnly?: boolean; sinceIso?: string } = {}): Array<{
    started: string;
    completed: string;
    durationMs: number | null;
    details: Record<string, unknown>;
  }> {
    const conds: string[] = ["operation = 'dream_complete'"];
    const params: unknown[] = [];
    if (opts.sinceIso) {
      conds.push("timestamp >= ?");
      params.push(opts.sinceIso);
    }
    const where = conds.join(" AND ");
    const rows = this.db
      .prepare(
        `SELECT timestamp, details, duration_ms FROM audit_log WHERE ${where} ORDER BY timestamp DESC LIMIT ?`
      )
      .all(...params, limit) as Array<{ timestamp: string; details: string | null; duration_ms: number | null }>;

    const out = rows.map((r) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = r.details ? JSON.parse(r.details) : {}; } catch { /* leave empty */ }
      return {
        started: typeof parsed.startedAt === "string" ? parsed.startedAt : r.timestamp,
        completed: r.timestamp,
        durationMs: r.duration_ms,
        details: parsed,
      };
    });

    if (opts.failuresOnly) {
      return out.filter((r) => {
        const d = r.details as Record<string, unknown>;
        return Number(d.errors || 0) > 0 || Boolean(d.providerUnreachable);
      });
    }
    return out;
  }

  /** Convenience: most recent successful dream run (had > 0 LLM-driven outputs). */
  getLastSuccessfulDreamRun(): { completed: string; details: Record<string, unknown> } | null {
    const recent = this.getRecentDreamRuns(50);
    for (const r of recent) {
      const d = r.details;
      const summaries = Number(d.summariesGenerated || 0);
      const decays = Number(d.decayUpdated || 0);
      const rels = Number(d.relationshipsDiscovered || 0);
      if (summaries + decays + rels > 0) {
        return { completed: r.completed, details: d };
      }
    }
    return null;
  }

  // ─── Sync state (v5.3.0) ────────────────────────────────────────────

  /** Queue a memory for remote sync when reconnected */
  enqueuePendingSync(memoryId: string, operation: "add" | "update" | "archive"): void {
    this.db.prepare(
      "INSERT INTO pending_sync (memory_id, operation, timestamp) VALUES (?, ?, ?)"
    ).run(memoryId, operation, new Date().toISOString());
  }

  getPendingSync(): Array<{ id: number; memory_id: string; operation: string; timestamp: string }> {
    return this.db.prepare(
      "SELECT id, memory_id, operation, timestamp FROM pending_sync WHERE status = 'pending' ORDER BY timestamp ASC"
    ).all() as Array<{ id: number; memory_id: string; operation: string; timestamp: string }>;
  }

  markPendingSyncComplete(id: number): void {
    this.db.prepare("UPDATE pending_sync SET status = 'pushed' WHERE id = ?").run(id);
  }

  clearOldPendingSync(daysOld: number = 30): number {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(
      "DELETE FROM pending_sync WHERE status = 'pushed' AND timestamp < ?"
    ).run(cutoff);
    return result.changes as number;
  }

  /** Track a conflict for AI-mediated resolution */
  recordConflict(memoryId: string, localModified: string, remoteModified: string, localSnapshot?: string, remoteSnapshot?: string): void {
    this.db.prepare(`
      INSERT INTO sync_conflicts (memory_id, detected_at, local_modified, remote_modified, local_snapshot, remote_snapshot)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        detected_at = excluded.detected_at,
        local_modified = excluded.local_modified,
        remote_modified = excluded.remote_modified,
        local_snapshot = excluded.local_snapshot,
        remote_snapshot = excluded.remote_snapshot,
        status = 'unresolved'
    `).run(memoryId, new Date().toISOString(), localModified, remoteModified, localSnapshot || null, remoteSnapshot || null);
  }

  getUnresolvedConflicts(): Array<{ memory_id: string; detected_at: string; local_modified: string; remote_modified: string; local_snapshot: string | null; remote_snapshot: string | null }> {
    return this.db.prepare(
      "SELECT memory_id, detected_at, local_modified, remote_modified, local_snapshot, remote_snapshot FROM sync_conflicts WHERE status = 'unresolved' ORDER BY detected_at DESC"
    ).all() as Array<{ memory_id: string; detected_at: string; local_modified: string; remote_modified: string; local_snapshot: string | null; remote_snapshot: string | null }>;
  }

  resolveConflict(memoryId: string): void {
    this.db.prepare("UPDATE sync_conflicts SET status = 'resolved' WHERE memory_id = ?").run(memoryId);
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
