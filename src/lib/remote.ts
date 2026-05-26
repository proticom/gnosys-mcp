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

import { existsSync, statSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import os from "os";
import * as path from "path";
import { GnosysDB, type DbMemory } from "./db.js";
import { readMachineConfig } from "./machineConfig.js";
import type { ProgressCallback } from "./progress.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface RemoteConfig {
  /** Path to remote .gnosys directory (e.g., /Volumes/nas/gnosys) */
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
  /** Project rows pushed/pulled (separate counter from memories). */
  projectsPushed?: number;
  projectsPulled?: number;
  /** Audit log entries pushed/pulled (separate counter from memories). */
  auditPushed?: number;
  auditPulled?: number;
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
const META_AUDIT_PUSH = "audit_last_pushed_at";
const META_AUDIT_PULL = "audit_last_pulled_at";
const META_MACHINE_ID = "machine_id";
/** Machine-local sync observability — not replicated between databases. */
const SYNC_META_AUDIT_OPS = new Set(["remote_push", "remote_pull"]);

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

  /**
   * Get current sync status without modifying anything.
   *
   * v5.7.1 (#8a): fast-fail design.
   * - Caps remote query duration with a short busy_timeout (3s)
   * - Uses id+modified-only aggregates (one SQL call per side) instead of
   *   the prior N+1 getMemory loop, which was O(local × remote) over SMB
   * - On SQLITE_BUSY, returns a clear "remote DB busy" message rather than
   *   blocking the CLI indefinitely
   */
  async getStatus(): Promise<RemoteStatus> {
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
    let reachable = false;
    let remoteBusy = false;

    const remoteDb = this.getRemoteDb();
    if (remoteDb !== null) {
      reachable = true;
      // Drop the timeout so a contended write lock fails in ~3s instead of
      // the default 10s. Restore after.
      remoteDb.setBusyTimeout(3000);
      try {
        const since = lastSync || "1970-01-01T00:00:00Z";
        const localChanges = this.localDb.getIdsModifiedSince(since);
        const remoteChanges = remoteDb.getIdsModifiedSince(since);

        const remoteByIdMap = new Map(remoteChanges.map((r) => [r.id, r.modified]));
        const localByIdMap = new Map(localChanges.map((l) => [l.id, l.modified]));

        // When remote is reachable, replace the queued-only count with an
        // accurate diff against the remote DB. (Matches pre-v5.7.1 semantics.)
        let pushCount = 0;
        for (const l of localChanges) {
          const rMod = remoteByIdMap.get(l.id);
          if (!rMod || l.modified > rMod) pushCount++;
        }
        for (const r of remoteChanges) {
          const lMod = localByIdMap.get(r.id);
          if (!lMod || r.modified > lMod) pendingPull++;
        }
        pendingPush = pushCount;
      } catch (err) {
        const errAny = err as { code?: string };
        if (errAny?.code === "SQLITE_BUSY") {
          remoteBusy = true;
        } else {
          throw err;
        }
      } finally {
        remoteDb.setBusyTimeout(10000);
      }
    }

    let message: string | undefined;
    if (remoteBusy) {
      message = "Remote DB busy — another sync is probably running on another machine. Try again in a moment.";
    } else if (!reachable && this.remotePath) {
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

  /**
   * Sync the projects table from local → remote.
   *
   * Projects are simpler than memories — they rarely conflict in practice
   * (one user's project metadata isn't typically edited from two machines
   * simultaneously). We use newer-wins semantics for projects: if both
   * sides have a project row, take the one with the later `modified`
   * timestamp. `insertProject` already does INSERT OR REPLACE.
   */
  private pushProjectsToRemote(remoteDb: GnosysDB, _lastSync: string, result: SyncResult): void {
    // Projects are few (typically <50 per user) and rarely conflict, so we
    // iterate ALL local projects rather than filtering by lastSync. This
    // also handles initial recovery: when remote has 0 projects but local
    // has many, every project gets pushed regardless of when it was created.
    const localProjects = this.localDb.getAllProjects();

    for (const local of localProjects) {
      const remote = remoteDb.getProject(local.id);
      if (!remote) {
        try {
          remoteDb.insertProject(local);
          result.projectsPushed = (result.projectsPushed || 0) + 1;
        } catch (err) {
          result.errors.push(`Failed to push project ${local.id}: ${(err as Error).message}`);
        }
        continue;
      }
      if (local.modified > remote.modified) {
        try {
          remoteDb.insertProject(local);
          result.projectsPushed = (result.projectsPushed || 0) + 1;
        } catch (err) {
          result.errors.push(`Failed to push project ${local.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  /**
   * Sync the audit_log table local → remote.
   *
   * Audit is append-only: entries never update or delete, so there are no
   * conflicts. Each row's `id` is local-only (autoincrement) — we ignore it
   * on insert so the remote assigns its own.
   *
   * High-water marks are per-DIRECTION (not "the latest timestamp seen
   * anywhere"), tracked in gnosys_meta:
   *   - audit_last_pushed_at  — last local timestamp we've pushed
   *   - audit_last_pulled_at  — last remote timestamp we've pulled
   * This avoids losing entries that are older than the other side's max.
   */
  private pushAuditToRemote(remoteDb: GnosysDB, result: SyncResult): void {
    const cursor = this.localDb.getMeta(META_AUDIT_PUSH) ?? "1970-01-01T00:00:00Z";
    const localChanges = this.localDb.getAuditEntriesAfter(cursor);
    if (localChanges.length === 0) return;
    let lastPushed = cursor;
    for (const entry of localChanges) {
      if (SYNC_META_AUDIT_OPS.has(entry.operation)) {
        if (entry.timestamp > lastPushed) lastPushed = entry.timestamp;
        continue;
      }
      try {
        remoteDb.logAudit({
          timestamp: entry.timestamp,
          operation: entry.operation,
          memory_id: entry.memory_id,
          details: entry.details,
          duration_ms: entry.duration_ms,
          trace_id: entry.trace_id,
        });
        result.auditPushed = (result.auditPushed || 0) + 1;
        if (entry.timestamp > lastPushed) lastPushed = entry.timestamp;
      } catch (err) {
        result.errors.push(`Failed to push audit ${entry.timestamp}: ${(err as Error).message}`);
      }
    }
    if (lastPushed !== cursor) this.localDb.setMeta(META_AUDIT_PUSH, lastPushed);
  }

  /**
   * Sync the audit_log table remote → local. Skips entries we just pushed
   * (recognized via the push high-water mark) so a push-then-pull cycle
   * doesn't duplicate them locally.
   */
  private pullAuditFromRemote(remoteDb: GnosysDB, result: SyncResult): void {
    const pullCursor = this.localDb.getMeta(META_AUDIT_PULL) ?? "1970-01-01T00:00:00Z";
    const pushCursor = this.localDb.getMeta(META_AUDIT_PUSH) ?? "1970-01-01T00:00:00Z";
    const remoteChanges = remoteDb.getAuditEntriesAfter(pullCursor);
    if (remoteChanges.length === 0) return;
    let lastPulled = pullCursor;
    for (const entry of remoteChanges) {
      // Skip entries we authored ourselves (already at home in our local DB).
      // pushCursor is the most recent timestamp we pushed; entries up to and
      // including it on the remote are either ours or already local.
      if (entry.timestamp <= pushCursor) {
        if (entry.timestamp > lastPulled) lastPulled = entry.timestamp;
        continue;
      }
      if (SYNC_META_AUDIT_OPS.has(entry.operation)) {
        if (entry.timestamp > lastPulled) lastPulled = entry.timestamp;
        continue;
      }
      try {
        this.localDb.logAudit({
          timestamp: entry.timestamp,
          operation: entry.operation,
          memory_id: entry.memory_id,
          details: entry.details,
          duration_ms: entry.duration_ms,
          trace_id: entry.trace_id,
        });
        result.auditPulled = (result.auditPulled || 0) + 1;
        if (entry.timestamp > lastPulled) lastPulled = entry.timestamp;
      } catch (err) {
        result.errors.push(`Failed to pull audit ${entry.timestamp}: ${(err as Error).message}`);
      }
    }
    if (lastPulled !== pullCursor) this.localDb.setMeta(META_AUDIT_PULL, lastPulled);
  }

  /** Sync the projects table from remote → local. Newer-wins semantics. */
  private pullProjectsFromRemote(remoteDb: GnosysDB, _lastSync: string, result: SyncResult): void {
    // See pushProjectsToRemote — iterate all rather than filtering by lastSync.
    const remoteProjects = remoteDb.getAllProjects();

    for (const remote of remoteProjects) {
      const local = this.localDb.getProject(remote.id);
      if (!local) {
        try {
          this.localDb.insertProject(remote);
          result.projectsPulled = (result.projectsPulled || 0) + 1;
        } catch (err) {
          result.errors.push(`Failed to pull project ${remote.id}: ${(err as Error).message}`);
        }
        continue;
      }
      if (remote.modified > local.modified) {
        try {
          this.localDb.insertProject(remote);
          result.projectsPulled = (result.projectsPulled || 0) + 1;
        } catch (err) {
          result.errors.push(`Failed to pull project ${remote.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Push local changes to remote. Returns what was pushed/skipped. */
  async push(
    options: {
      strategy?: "skip-and-flag" | "newer-wins";
      onProgress?: ProgressCallback;
    } = {},
  ): Promise<SyncResult> {
    const strategy = options.strategy || "skip-and-flag";
    const onProgress = options.onProgress;
    const remoteDb = this.getRemoteDb();
    if (!remoteDb) {
      return { pushed: 0, pulled: 0, conflicts: [], errors: ["Remote not reachable"], skipped: 0 };
    }

    const lastSync = this.localDb.getMeta(META_LAST_SYNC) || "1970-01-01T00:00:00Z";
    const localChanges = this.localDb
      .getAllMemories()
      .filter((m) => (m.modified || m.created) > lastSync);

    onProgress?.({ kind: "header", text: `Push: ${localChanges.length} local change(s) since ${lastSync}` });

    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: [], errors: [], skipped: 0 };

    for (const local of localChanges) {
      onProgress?.({ kind: "tick", text: `→ ${local.id}` });
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
    if (queued.length > 0) {
      onProgress?.({ kind: "step", text: `Replaying ${queued.length} queued write(s)` });
    }
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

    // Sync the projects table — historically this was skipped, leaving the
    // remote with orphan memories (memories with no project rows). v5.4.1
    // closes this gap.
    this.pushProjectsToRemote(remoteDb, lastSync, result);

    // v5.7.0: also sync audit_log so `gnosys audit` works against the
    // remote DB (which would otherwise be empty for this table).
    this.pushAuditToRemote(remoteDb, result);

    onProgress?.({
      kind: "done",
      text: `Push complete: ${result.pushed} pushed, ${result.skipped} skipped, ${result.conflicts.length} conflicts`,
    });
    this.localDb.logAudit({
      timestamp: new Date().toISOString(),
      operation: "remote_push",
      memory_id: null,
      details: JSON.stringify({
        pushed: result.pushed,
        skipped: result.skipped,
        conflicts: result.conflicts.length,
      }),
      duration_ms: null,
      trace_id: null,
    });
    return result;
  }

  /** Pull remote changes to local. Returns what was pulled/skipped. */
  async pull(
    options: {
      strategy?: "skip-and-flag" | "newer-wins";
      onProgress?: ProgressCallback;
    } = {},
  ): Promise<SyncResult> {
    const strategy = options.strategy || "skip-and-flag";
    const onProgress = options.onProgress;
    const remoteDb = this.getRemoteDb();
    if (!remoteDb) {
      return { pushed: 0, pulled: 0, conflicts: [], errors: ["Remote not reachable"], skipped: 0 };
    }

    const lastSync = this.localDb.getMeta(META_LAST_SYNC) || "1970-01-01T00:00:00Z";
    const remoteChanges = remoteDb
      .getAllMemories()
      .filter((m) => (m.modified || m.created) > lastSync);

    onProgress?.({ kind: "header", text: `Pull: ${remoteChanges.length} remote change(s) since ${lastSync}` });

    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: [], errors: [], skipped: 0 };

    for (const remote of remoteChanges) {
      onProgress?.({ kind: "tick", text: `← ${remote.id}` });
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

    // Sync the projects table — see pushProjectsToRemote for context.
    this.pullProjectsFromRemote(remoteDb, lastSync, result);

    // v5.7.0: pull audit_log too.
    this.pullAuditFromRemote(remoteDb, result);

    onProgress?.({
      kind: "done",
      text: `Pull complete: ${result.pulled} pulled, ${result.skipped} skipped, ${result.conflicts.length} conflicts`,
    });
    this.localDb.logAudit({
      timestamp: new Date().toISOString(),
      operation: "remote_pull",
      memory_id: null,
      details: JSON.stringify({
        pulled: result.pulled,
        skipped: result.skipped,
        conflicts: result.conflicts.length,
      }),
      duration_ms: null,
      trace_id: null,
    });
    return result;
  }

  /** Run a full sync: push then pull. */
  async sync(
    options: {
      auto?: boolean;
      strategy?: "skip-and-flag" | "newer-wins";
      onProgress?: ProgressCallback;
    } = {},
  ): Promise<SyncResult> {
    const strategy = options.strategy || (options.auto ? "skip-and-flag" : "skip-and-flag");
    const onProgress = options.onProgress;
    const pushResult = await this.push({ strategy, onProgress });
    const pullResult = await this.pull({ strategy, onProgress });

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
      projectsPushed: (pushResult.projectsPushed || 0) + (pullResult.projectsPushed || 0),
      projectsPulled: (pushResult.projectsPulled || 0) + (pullResult.projectsPulled || 0),
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

    // Copy all projects first — memories reference project_id, so projects
    // need to land on the remote before any memories that reference them.
    const projects = this.localDb.getAllProjects();
    for (const proj of projects) {
      try {
        remoteDb.insertProject(proj);
        copied++;
      } catch (err) {
        errors.push(`Failed to copy project ${proj.id}: ${(err as Error).message}`);
      }
    }

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
 *
 * v5.9.4 Bug 9 — on macOS, neither `HOSTNAME` nor `COMPUTERNAME` are set
 * by default in subshells, which caused identifiers like `unknown-mp9cyh4j`.
 * `os.hostname()` is the reliable fallback before giving up to `unknown`.
 *
 * v5.9.5 — self-heal: when the cached value is a pre-fix `unknown-<rand>`
 * id and `resolveHostname()` now returns a real name, overwrite the cache
 * (and any `dream_machine_id` pointing at the broken id) so users who
 * upgrade past v5.9.4 stop seeing the stale identifier in panels.
 */
export function getMachineId(localDb: GnosysDB): string {
  // v5.11: machine identity lives in machine-local machine.json (never synced).
  // Prefer it so a shared/synced gnosys_meta can't make two machines collide.
  // Fall back to the legacy synced meta value when machine.json is absent.
  const mc = readMachineConfig();
  if (mc?.machineId) return mc.machineId;
  const cached = localDb.getMeta(META_MACHINE_ID);
  if (cached && !isStaleUnknownId(cached)) return cached;
  const fresh = `${resolveHostname()}-${Date.now().toString(36)}`;
  // Don't churn the cache if we still can't resolve a real hostname —
  // keep the existing `unknown-<rand>` row so the id stays stable.
  if (cached && fresh.startsWith("unknown-")) return cached;
  localDb.setMeta(META_MACHINE_ID, fresh);
  // Heal a dream_machine_id that points at the broken cached id.
  if (cached && localDb.getDreamMachineId() === cached) {
    localDb.setDreamMachineId(fresh);
  }
  return fresh;
}

/** v5.9.5 — match the pre-fix `unknown-<base36>` shape. */
function isStaleUnknownId(id: string): boolean {
  return /^unknown-[a-z0-9]+$/.test(id);
}

/**
 * Resolve a usable hostname for machine-id generation. Honours common
 * env vars first (cross-platform tests can override), then falls through
 * to `os.hostname()` so macOS shells without `HOSTNAME` still get a real
 * name. Returns `"unknown"` only when everything fails.
 */
export function resolveHostname(): string {
  const fromEnv = process.env.HOSTNAME || process.env.COMPUTERNAME;
  if (fromEnv) return fromEnv;
  try {
    const fromOs = os.hostname();
    if (fromOs) return fromOs;
  } catch {
    // os.hostname() is documented to throw on some platforms — fall through.
  }
  return "unknown";
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
