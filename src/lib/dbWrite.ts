/**
 * Gnosys DB Write — Dual-write layer for v2.0 migration.
 *
 * When gnosys.db is available, all write operations go to BOTH:
 *   1. .md files (via GnosysStore) — safety net + Obsidian compatibility
 *   2. gnosys.db (via GnosysDB) — primary store for agent reads
 *
 * This module provides helper functions that MCP tools and maintenance
 * call after writing to the .md store. It also handles syncing writes
 * that bypass the .md layer (e.g., maintenance operations on archived
 * memories).
 *
 * Once the Obsidian Export Bridge (Phase 7e) is complete, .md writes
 * become optional — controlled by config.
 */

import { GnosysDB, DbMemory } from "./db.js";
import { MemoryFrontmatter, Memory } from "./store.js";
import { fnv1a } from "./db.js";

/**
 * Sync a memory write to gnosys.db after it's been written to .md.
 * Call this after GnosysStore.writeMemory() or updateMemory().
 *
 * v3.0: Accepts optional projectId and scope for centralized brain.
 */
export function syncMemoryToDb(
  db: GnosysDB,
  frontmatter: MemoryFrontmatter,
  content: string,
  sourcePath?: string,
  projectId?: string | null,
  scope?: string
): void {
  if (!db.isAvailable()) return;

  const tags = Array.isArray(frontmatter.tags)
    ? JSON.stringify(frontmatter.tags)
    : JSON.stringify(Object.values(frontmatter.tags).flat());

  db.insertMemory({
    id: frontmatter.id,
    title: frontmatter.title,
    category: frontmatter.category,
    content,
    summary: null,
    tags,
    relevance: (frontmatter.relevance as string) || "",
    author: frontmatter.author || "ai",
    authority: frontmatter.authority || "imported",
    confidence: frontmatter.confidence ?? 0.8,
    reinforcement_count: frontmatter.reinforcement_count ?? 0,
    content_hash: fnv1a(content),
    status: frontmatter.status || "active",
    tier: frontmatter.status === "archived" ? "archive" : "active",
    supersedes: frontmatter.supersedes || null,
    superseded_by: frontmatter.superseded_by || null,
    last_reinforced: frontmatter.last_reinforced || null,
    created: frontmatter.created || new Date().toISOString().split("T")[0],
    modified: frontmatter.modified || new Date().toISOString().split("T")[0],
    source_path: sourcePath || null,
    project_id: projectId || null,
    scope: scope || "project",
  });
}

/**
 * Sync a memory update to gnosys.db after it's been updated in .md.
 */
export function syncUpdateToDb(
  db: GnosysDB,
  id: string,
  updates: Partial<MemoryFrontmatter>,
  newContent?: string
): void {
  if (!db.isAvailable()) return;

  const dbUpdates: Partial<DbMemory> = {};

  if (updates.title !== undefined) dbUpdates.title = updates.title;
  if (updates.category !== undefined) dbUpdates.category = updates.category;
  if (updates.status !== undefined) {
    dbUpdates.status = updates.status;
    if (updates.status === "archived") dbUpdates.tier = "archive";
  }
  if (updates.confidence !== undefined) dbUpdates.confidence = updates.confidence;
  if (updates.relevance !== undefined) dbUpdates.relevance = updates.relevance as string;
  if (updates.supersedes !== undefined) dbUpdates.supersedes = updates.supersedes || null;
  if (updates.superseded_by !== undefined) dbUpdates.superseded_by = updates.superseded_by || null;
  if (updates.reinforcement_count !== undefined) dbUpdates.reinforcement_count = updates.reinforcement_count;
  if (updates.last_reinforced !== undefined) dbUpdates.last_reinforced = updates.last_reinforced || null;
  if (updates.tags !== undefined) {
    dbUpdates.tags = Array.isArray(updates.tags)
      ? JSON.stringify(updates.tags)
      : JSON.stringify(Object.values(updates.tags).flat());
  }
  if (updates.author !== undefined) dbUpdates.author = updates.author;
  if (updates.authority !== undefined) dbUpdates.authority = updates.authority;

  if (newContent !== undefined) {
    dbUpdates.content = newContent;
    dbUpdates.content_hash = fnv1a(newContent);
  }

  dbUpdates.modified = new Date().toISOString().split("T")[0];

  db.updateMemory(id, dbUpdates);
}

/**
 * Sync an archive operation to gnosys.db.
 * Sets tier='archive' on the memory.
 */
export function syncArchiveToDb(db: GnosysDB, memoryId: string): void {
  if (!db.isAvailable()) return;
  db.updateMemory(memoryId, {
    tier: "archive",
    status: "archived",
    modified: new Date().toISOString().split("T")[0],
  });
}

/**
 * Sync a dearchive operation to gnosys.db.
 * Sets tier='active' on the memory.
 */
export function syncDearchiveToDb(db: GnosysDB, memoryId: string): void {
  if (!db.isAvailable()) return;
  db.updateMemory(memoryId, {
    tier: "active",
    status: "active",
    modified: new Date().toISOString().split("T")[0],
  });
}

/**
 * Sync a delete operation to gnosys.db.
 */
export function syncDeleteToDb(db: GnosysDB, memoryId: string): void {
  if (!db.isAvailable()) return;
  db.deleteMemory(memoryId);
}

/**
 * Sync a reinforcement to gnosys.db.
 */
export function syncReinforcementToDb(
  db: GnosysDB,
  memoryId: string,
  newCount: number
): void {
  if (!db.isAvailable()) return;
  db.updateMemory(memoryId, {
    reinforcement_count: newCount,
    last_reinforced: new Date().toISOString().split("T")[0],
    modified: new Date().toISOString().split("T")[0],
  });
}

/**
 * Sync a confidence update to gnosys.db (e.g., from decay).
 */
export function syncConfidenceToDb(
  db: GnosysDB,
  memoryId: string,
  newConfidence: number
): void {
  if (!db.isAvailable()) return;
  db.updateMemory(memoryId, {
    confidence: newConfidence,
    modified: new Date().toISOString().split("T")[0],
  });
}

/**
 * Log an audit entry to gnosys.db's audit_log table.
 * This supplements (and eventually replaces) the JSONL audit log.
 */
export function auditToDb(
  db: GnosysDB,
  operation: string,
  memoryId?: string,
  details?: Record<string, unknown>,
  durationMs?: number,
  traceId?: string
): void {
  if (!db.isAvailable()) return;
  db.logAudit({
    timestamp: new Date().toISOString(),
    operation,
    memory_id: memoryId || null,
    details: details ? JSON.stringify(details) : null,
    duration_ms: durationMs ? Math.round(durationMs) : null,
    trace_id: traceId || null,
  });
}
