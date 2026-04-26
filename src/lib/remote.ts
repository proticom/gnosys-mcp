/**
 * Gnosys Remote Sync — multi-machine database synchronization
 *
 * Hybrid sync strategy:
 * - Local DB acts as a fast working cache
 * - Remote DB (typically NAS) is the canonical source of truth
 * - Reads always hit local for speed
 * - Writes go to local + queued for remote push
 * - Conflict detection via per-memory `modified` timestamps
 * - Skip-and-flag for auto sync; AI-mediated resolution for conflicts
 */

import { existsSync, statSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import * as path from "path";
import { GnosysDB, DbMemory } from "./db.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface RemoteConfig {
  /** Path to remote .gnosys directory (e.g., /Volumes/synology/gnosys) */
  path: string;
  /** Run sync automatically in background */
  autoSync?: boolean;
  /** Auto-sync interval in seconds (default 300) */
  autoSyncIntervalSeconds?: number;
  /** Conflict handling: skip-and-flag (safe) or newer-wins (aggressive) */
  conflictStrategy?: "skip-and-flag" | "newer-wins";
}

export interface ConflictInfo {
  memoryId: string;
  title: string;
  localModified: string;
  remoteModified: string;
  localSnapshot?: string;
  remoteSnapshot?: string;
}

export interface RemoteStatus {
  configured: boolean;
  reachable: boolean;
  remotePath?: string;
  lastSync: string | null;
  pendingPush: number;
  pendingPull: number;
  queuedWrites: number;
  conflicts: ConflictInfo[];
  message?: string;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: ConflictInfo[];
  errors: string[];
  skipped: number;
}

export interface ValidationResult {
  ok: boolean;
  checks: {
    pathExists: boolean;
    writable: boolean;
    sqliteCompatible: boolean;
    latencyMs: number | null;
    existingDb: { found: boolean; memoryCount?: number; lastModified?: string };
  };
  warnings: string[];
  errors: string[];
}

// ─── Validation ─────────────────────────────────────────────────────────

/**
 * Validate that a directory is suitable for hosting the remote gnosys.db.
 * Tests writability, SQLite locking, and latency.
 */
export async function validateLocation(remotePath: string): Promise<ValidationResult> {
  const result: ValidationResult = {
    ok: false,
    checks: {
      pathExists: false,
      writable: false,
      sqliteCompatible: false,
      latencyMs: null,
      existingDb: { found: false },
    },
    warnings: [],
    errors: [],
  };

  // 1. Path exists?
  try {
    const stat = statSync(remotePath);
    if (!stat.isDirectory()) {
      result.errors.push(`Path exists but is not a directory: ${remotePath}`);
      return result;
    }
    result.checks.pathExists = true;
  } catch {
    // Try to create it
    try {
      mkdirSync(remotePath, { recursive: true });
      result.checks.pathExists = true;
      result.warnings.push(`Created directory: ${remotePath}`);
    } catch (err) {
      result.errors.push(`Cannot access or create path: ${remotePath} (${(err as Error).message})`);
      return result;
    }
  }

  // 2. Writable?
  const testFile = path.join(remotePath, `.gnosys-write-test-${Date.now()}`);
  try {
    writeFileSync(testFile, "test");
    unlinkSync(testFile);
    result.checks.writable = true;
  } catch (err) {
    result.errors.push(`Cannot write to path: ${(err as Error).message}`);
    return result;
  }

  // 3. SQLite compatible?
  const testDbPath = path.join(remotePath, ".gnosys-sqlite-test");
  try {
    const start = Date.now();
    const testDb = new GnosysDB(remotePath);
    if (!testDb.isAvailable()) {
      result.errors.push("better-sqlite3 not available");
      return result;
    }
    // Simple read/write probe
    testDb.setMeta("__sqlite_test__", "ok");
    const val = testDb.getMeta("__sqlite_test__");
    testDb.close();
    if (val !== "ok") {
      result.errors.push("SQLite read/write probe failed — locking may be unreliable on this filesystem");
      return result;
    }
    result.checks.sqliteCompatible = true;
    result.checks.latencyMs = Date.now() - start;

    if (result.checks.latencyMs > 500) {
      result.warnings.push(`High latency detected: ${result.checks.latencyMs}ms (consider local DB if remote feels slow)`);
    }
  } catch (err) {
    result.errors.push(`SQLite test failed: ${(err as Error).message}`);
    return result;
  } finally {
    try {
      unlinkSync(testDbPath);
    } catch {
      // ignore
    }
  }

  // 4. Existing DB?
  const dbFile = path.join(remotePath, "gnosys.db");
  if (existsSync(dbFile)) {
    try {
      const db = new GnosysDB(remotePath);
      const counts = db.getMemoryCount();
      const stat = statSync(dbFile);
      db.close();
      result.checks.existingDb = {
        found: true,
        memoryCount: counts.total,
        lastModified: stat.mtime.toISOString(),
      };
    } catch {
      result.warnings.push("Found gnosys.db at path but couldn't read it");
      result.checks.existingDb = { found: true };
    }
  }

  result.ok = result.checks.pathExists && result.checks.writable && result.checks.sqliteCompatible;
  return result;
}

// ─── Sync engine ────────────────────────────────────────────────────────

const META_LAST_SYNC = "remote_last_synced_at";
const META_MACHINE_ID = "machine_id";

export class RemoteSync {
  private localDb: GnosysDB;
  private remotePath: string;
  private remoteDb: GnosysDB | null = null;

  constructor(localDb: GnosysDB, remotePath: string) {
    this.localDb = localDb;
    this.remotePath = remotePath;
  }

  /** Check if remote is reachable. Lazy-opens the remote DB. */
  private getRemoteDb(): GnosysDB | null {
    if (this.remoteDb) return this.remoteDb;
    try {
      // Check path is reachable first (mounted, accessible)
      if (!existsSync(this.remotePath)) return null;
      const db = new GnosysDB(this.remotePath);
      if (!db.isAvailable()) {
        db.close();
        return null;
      }
      this.remoteDb = db;
      return db;
    } catch {
      return null;
    }
  }

  closeRemote(): void {
    this.remoteDb?.close();
    this.remoteDb = null;
  }

  /** Get current sync status without modifying anything */
  async getStatus(): Promise<RemoteStatus> {
    const remoteDb = this.getRemoteDb();
    const reachable = remoteDb !== null;
    const lastSync = this.localDb.getMeta(META_LAST_SYNC);
    const queued = this.localDb.getPendingSync();
    const conflictRows = this.localDb.getUnresolvedConflicts();

    const conflicts: ConflictInfo[] = conflictRows.map((c) => {
      const local = this.localDb.getMemory(c.memory_id);
      return {
        memoryId: c.memory_id,
        title: local?.title || c.memory_id,
        localModified: c.local_modified,
        remoteModified: c.remote_modified,
        localSnapshot: c.local_snapshot || undefined,
        remoteSnapshot: c.remote_snapshot || undefined,
      };
    });

    let pendingPush = queued.length;
    let pendingPull = 0;

    if (reachable && remoteDb) {
      // Count memories that would push/pull on next sync
      const since = lastSync || "1970-01-01T00:00:00Z";
      const localChanges = this.localDb
        .getAllMemories()
        .filter((m) => (m.modified || m.created) > since);
      const remoteChanges = remoteDb
        .getAllMemories()
        .filter((m) => (m.modified || m.created) > since);

      const remoteIds = new Set(remoteChanges.map((m) => m.id));
      pendingPush = localChanges.filter((m) => {
        const remote = remoteDb.getMemory(m.id);
        if (!remote) return true; // not on remote
        return m.modified > remote.modified;
      }).length;

      pendingPull = remoteChanges.filter((m) => {
        const local = this.localDb.getMemory(m.id);
        if (!local) return true;
        return m.modified > local.modified;
      }).length;
    }

    let message: string | undefined;
    if (!reachable && this.remotePath) {
      message = `Remote unreachable at ${this.remotePath}`;
    } else if (conflicts.length > 0) {
      message = `${conflicts.length} unresolved conflict${conflicts.length !== 1 ? "s" : ""} need attention`;
    } else if (pendingPush > 0 || pendingPull > 0) {
      const parts: string[] = [];
      if (pendingPush > 0) parts.push(`${pendingPush} to push`);
      if (pendingPull > 0) parts.push(`${pendingPull} to pull`);
      message = `Sync needed: ${parts.join(", ")}`;
    }

    return {
      configured: true,
      reachable,
      remotePath: this.remotePath,
      lastSync,
      pendingPush,
      pendingPull,
      queuedWrites: queued.length,
      conflicts,
      message,
    };
  }

  /** Push local changes to remote. Returns what was pushed/skipped. */
  async push(options: { strategy?: "skip-and-flag" | "newer-wins" } = {}): Promise<SyncResult> {
    const strategy = options.strategy || "skip-and-flag";
    const remoteDb = this.getRemoteDb();
    if (!remoteDb) {
      return { pushed: 0, pulled: 0, conflicts: [], errors: ["Remote not reachable"], skipped: 0 };
    }

    const lastSync = this.localDb.getMeta(META_LAST_SYNC) || "1970-01-01T00:00:00Z";
    const localChanges = this.localDb
      .getAllMemories()
      .filter((m) => (m.modified || m.created) > lastSync);

    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: [], errors: [], skipped: 0 };

    for (const local of localChanges) {
      const remote = remoteDb.getMemory(local.id);

      if (!remote) {
        // Memory only exists locally — push
        try {
          remoteDb.insertMemory(local);
          result.pushed++;
        } catch (err) {
          result.errors.push(`Failed to push ${local.id}: ${(err as Error).message}`);
        }
        continue;
      }

      // Both exist — check if remote was also modified since last sync
      const remoteChangedSinceSync = remote.modified > lastSync;

      if (!remoteChangedSinceSync) {
        // Remote unchanged — push local
        if (local.modified > remote.modified) {
          try {
            remoteDb.insertMemory(local);
            result.pushed++;
          } catch (err) {
            result.errors.push(`Failed to push ${local.id}: ${(err as Error).message}`);
          }
        } else {
          result.skipped++;
        }
      } else {
        // Both modified since last sync — true conflict
        if (local.modified === remote.modified) {
          // Same timestamp, assume same content
          result.skipped++;
          continue;
        }
        if (strategy === "newer-wins") {
          // Take whichever is newer
          if (local.modified > remote.modified) {
            try {
              remoteDb.insertMemory(local);
              result.pushed++;
            } catch (err) {
              result.errors.push(`Failed to push ${local.id}: ${(err as Error).message}`);
            }
          } else {
            // Remote is newer — handled by pull, skip here
            result.skipped++;
          }
        } else {
          // skip-and-flag — record conflict
          this.localDb.recordConflict(
            local.id,
            local.modified,
            remote.modified,
            JSON.stringify({ title: local.title, content: local.content }),
            JSON.stringify({ title: remote.title, content: remote.content })
          );
          result.conflicts.push({
            memoryId: local.id,
            title: local.title,
            localModified: local.modified,
            remoteModified: remote.modified,
          });
          result.skipped++;
        }
      }
    }

    // Process pending sync queue (offline writes)
    const queued = this.localDb.getPendingSync();
    for (const item of queued) {
      const local = this.localDb.getMemory(item.memory_id);
      if (!local) continue;
      try {
        remoteDb.insertMemory(local);
        this.localDb.markPendingSyncComplete(item.id);
        result.pushed++;
      } catch (err) {
        result.errors.push(`Failed to replay ${item.memory_id}: ${(err as Error).message}`);
      }
    }

    return result;
  }

  /** Pull remote changes to local. Returns what was pulled/skipped. */
  async pull(options: { strategy?: "skip-and-flag" | "newer-wins" } = {}): Promise<SyncResult> {
    const strategy = options.strategy || "skip-and-flag";
    const remoteDb = this.getRemoteDb();
    if (!remoteDb) {
      return { pushed: 0, pulled: 0, conflicts: [], errors: ["Remote not reachable"], skipped: 0 };
    }

    const lastSync = this.localDb.getMeta(META_LAST_SYNC) || "1970-01-01T00:00:00Z";
    const remoteChanges = remoteDb
      .getAllMemories()
      .filter((m) => (m.modified || m.created) > lastSync);

    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: [], errors: [], skipped: 0 };

    for (const remote of remoteChanges) {
      const local = this.localDb.getMemory(remote.id);

      if (!local) {
        // Memory only exists on remote — pull
        try {
          this.localDb.insertMemory(remote);
          result.pulled++;
        } catch (err) {
          result.errors.push(`Failed to pull ${remote.id}: ${(err as Error).message}`);
        }
        continue;
      }

      // Both exist — compare timestamps
      if (remote.modified > local.modified && local.modified <= lastSync) {
        // Remote newer, local unchanged since last sync — pull
        try {
          this.localDb.insertMemory(remote);
          result.pulled++;
        } catch (err) {
          result.errors.push(`Failed to pull ${remote.id}: ${(err as Error).message}`);
        }
      } else if (remote.modified > local.modified && local.modified > lastSync) {
        // Both modified — conflict
        if (strategy === "newer-wins") {
          // Remote is already newer — pull it
          try {
            this.localDb.insertMemory(remote);
            result.pulled++;
          } catch (err) {
            result.errors.push(`Failed to pull ${remote.id}: ${(err as Error).message}`);
          }
        } else {
          // Already recorded by push, but capture if not
          this.localDb.recordConflict(
            local.id,
            local.modified,
            remote.modified,
            JSON.stringify({ title: local.title, content: local.content }),
            JSON.stringify({ title: remote.title, content: remote.content })
          );
          result.conflicts.push({
            memoryId: local.id,
            title: local.title,
            localModified: local.modified,
            remoteModified: remote.modified,
          });
          result.skipped++;
        }
      } else {
        result.skipped++;
      }
    }

    return result;
  }

  /** Run a full sync: push then pull. */
  async sync(options: { auto?: boolean; strategy?: "skip-and-flag" | "newer-wins" } = {}): Promise<SyncResult> {
    const strategy = options.strategy || (options.auto ? "skip-and-flag" : "skip-and-flag");
    const pushResult = await this.push({ strategy });
    const pullResult = await this.pull({ strategy });

    // Update last sync timestamp on success (no errors)
    if (pushResult.errors.length === 0 && pullResult.errors.length === 0) {
      this.localDb.setMeta(META_LAST_SYNC, new Date().toISOString());
    }

    return {
      pushed: pushResult.pushed + pullResult.pushed,
      pulled: pushResult.pulled + pullResult.pulled,
      conflicts: [...pushResult.conflicts, ...pullResult.conflicts],
      errors: [...pushResult.errors, ...pullResult.errors],
      skipped: pushResult.skipped + pullResult.skipped,
    };
  }

  /** Resolve a specific conflict by choosing local, remote, or merged content */
  async resolve(
    memoryId: string,
    choice: "local" | "remote" | "merged",
    mergedMemory?: Partial<DbMemory>
  ): Promise<{ ok: boolean; error?: string }> {
    const remoteDb = this.getRemoteDb();
    if (!remoteDb) {
      return { ok: false, error: "Remote not reachable" };
    }

    const local = this.localDb.getMemory(memoryId);
    const remote = remoteDb.getMemory(memoryId);

    if (!local && !remote) {
      return { ok: false, error: `Memory not found: ${memoryId}` };
    }

    try {
      if (choice === "local" && local) {
        // Push local to remote, mark resolved
        const updated = { ...local, modified: new Date().toISOString() };
        remoteDb.insertMemory(updated);
        this.localDb.insertMemory(updated);
      } else if (choice === "remote" && remote) {
        // Pull remote to local
        const updated = { ...remote, modified: new Date().toISOString() };
        this.localDb.insertMemory(updated);
        remoteDb.insertMemory(updated);
      } else if (choice === "merged" && mergedMemory) {
        // Use the merged content (must include id, title, content at minimum)
        const base = local || remote;
        if (!base) return { ok: false, error: "No base memory found" };
        const merged: DbMemory = {
          ...base,
          ...mergedMemory,
          modified: new Date().toISOString(),
        } as DbMemory;
        this.localDb.insertMemory(merged);
        remoteDb.insertMemory(merged);
      } else {
        return { ok: false, error: `Invalid choice: ${choice}` };
      }

      this.localDb.resolveConflict(memoryId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Initial migration: copy local DB to remote location */
  async migrate(): Promise<{ ok: boolean; copied: number; errors: string[] }> {
    const remoteDb = this.getRemoteDb();
    if (!remoteDb) {
      return { ok: false, copied: 0, errors: ["Remote not reachable"] };
    }

    const errors: string[] = [];
    let copied = 0;

    // Copy all memories
    const memories = this.localDb.getAllMemories();
    for (const mem of memories) {
      try {
        remoteDb.insertMemory(mem);
        copied++;
      } catch (err) {
        errors.push(`Failed to copy ${mem.id}: ${(err as Error).message}`);
      }
    }

    // Mark sync as complete
    if (errors.length === 0) {
      this.localDb.setMeta(META_LAST_SYNC, new Date().toISOString());
    }

    return { ok: errors.length === 0, copied, errors };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Get a stable machine identifier for tracking which machine wrote what.
 * Generates one on first call and stores it in gnosys_meta.
 */
export function getMachineId(localDb: GnosysDB): string {
  let id = localDb.getMeta(META_MACHINE_ID);
  if (!id) {
    const hostname = process.env.HOSTNAME || process.env.COMPUTERNAME || "unknown";
    id = `${hostname}-${Date.now().toString(36)}`;
    localDb.setMeta(META_MACHINE_ID, id);
  }
  return id;
}

/** Format a sync status for human display */
export function formatStatus(status: RemoteStatus): string {
  if (!status.configured) {
    return "Remote sync: not configured. Run 'gnosys remote configure' to set up.";
  }
  if (!status.reachable) {
    return `Remote sync: unreachable at ${status.remotePath}`;
  }

  const lines: string[] = [];
  lines.push(`Remote: ${status.remotePath}`);
  lines.push(`Last sync: ${status.lastSync || "never"}`);
  lines.push(`Pending push: ${status.pendingPush}`);
  lines.push(`Pending pull: ${status.pendingPull}`);
  lines.push(`Queued writes: ${status.queuedWrites}`);
  lines.push(`Conflicts: ${status.conflicts.length}`);
  if (status.message) lines.push(`Status: ${status.message}`);
  return lines.join("\n");
}
