/**
 * Tests for the remote sync engine (src/lib/remote.ts).
 *
 * Covers: validation, push, pull, conflict detection, resolution,
 * offline queue replay, and the migrate flow.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { GnosysDB, DbMemory } from "../lib/db.js";
import { RemoteSync, validateLocation, getMachineId, formatStatus } from "../lib/remote.js";

// ─── Helpers ────────────────────────────────────────────────────────────

function makeMemory(id: string, overrides: Partial<DbMemory> = {}): DbMemory {
  const now = new Date().toISOString();
  return {
    id,
    title: `Memory ${id}`,
    category: "decisions",
    content: `Content of ${id}`,
    summary: null,
    tags: '["test"]',
    relevance: "test memory",
    author: "human+ai",
    authority: "declared",
    confidence: 0.9,
    reinforcement_count: 0,
    content_hash: "abc123",
    status: "active",
    tier: "active",
    supersedes: null,
    superseded_by: null,
    last_reinforced: null,
    created: now,
    modified: now,
    embedding: null,
    source_path: null,
    source_file: null,
    source_page: null,
    source_timerange: null,
    project_id: null,
    scope: "project",
    ...overrides,
  } as DbMemory;
}

interface SyncEnv {
  localDir: string;
  remoteDir: string;
  localDb: GnosysDB;
  remoteDb: GnosysDB;
  sync: RemoteSync;
}

async function createSyncEnv(): Promise<SyncEnv> {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-remote-local-"));
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-remote-nas-"));
  const localDb = new GnosysDB(localDir);
  const remoteDb = new GnosysDB(remoteDir);
  const sync = new RemoteSync(localDb, remoteDir);
  return { localDir, remoteDir, localDb, remoteDb, sync };
}

async function cleanupSyncEnv(env: SyncEnv): Promise<void> {
  env.sync.closeRemote();
  env.localDb.close();
  env.remoteDb.close();
  await fsp.rm(env.localDir, { recursive: true, force: true });
  await fsp.rm(env.remoteDir, { recursive: true, force: true });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("validateLocation", () => {
  it("returns ok for a writable directory", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-validate-"));
    try {
      const result = await validateLocation(tmp);
      expect(result.ok).toBe(true);
      expect(result.checks.pathExists).toBe(true);
      expect(result.checks.writable).toBe(true);
      expect(result.checks.sqliteCompatible).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("creates the directory if it does not exist", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-validate-"));
    const newPath = path.join(parent, "new-subdir");
    try {
      const result = await validateLocation(newPath);
      expect(result.ok).toBe(true);
      expect(fs.existsSync(newPath)).toBe(true);
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });

  it("detects existing gnosys.db at path", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-validate-"));
    try {
      const db = new GnosysDB(tmp);
      db.insertMemory(makeMemory("test-001"));
      db.close();

      const result = await validateLocation(tmp);
      expect(result.ok).toBe(true);
      expect(result.checks.existingDb.found).toBe(true);
      expect(result.checks.existingDb.memoryCount).toBeGreaterThanOrEqual(1);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("RemoteSync.getStatus", () => {
  let env: SyncEnv;
  beforeEach(async () => { env = await createSyncEnv(); });
  afterEach(async () => { await cleanupSyncEnv(env); });

  it("reports reachable when remote exists", async () => {
    const status = await env.sync.getStatus();
    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.pendingPush).toBe(0);
    expect(status.pendingPull).toBe(0);
    expect(status.conflicts).toEqual([]);
  });

  it("reports unreachable when remote path missing", async () => {
    const fakePath = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
    const sync = new RemoteSync(env.localDb, fakePath);
    const status = await sync.getStatus();
    expect(status.reachable).toBe(false);
    expect(status.message).toContain("unreachable");
  });

  it("counts pending push when local has new memories", async () => {
    env.localDb.insertMemory(makeMemory("new-001"));
    env.localDb.insertMemory(makeMemory("new-002"));
    const status = await env.sync.getStatus();
    expect(status.pendingPush).toBe(2);
    expect(status.pendingPull).toBe(0);
  });

  it("counts pending pull when remote has new memories", async () => {
    env.remoteDb.insertMemory(makeMemory("remote-001"));
    const status = await env.sync.getStatus();
    expect(status.pendingPull).toBe(1);
    expect(status.pendingPush).toBe(0);
  });
});

describe("RemoteSync.push", () => {
  let env: SyncEnv;
  beforeEach(async () => { env = await createSyncEnv(); });
  afterEach(async () => { await cleanupSyncEnv(env); });

  it("pushes new local memories to remote", async () => {
    env.localDb.insertMemory(makeMemory("new-001"));
    env.localDb.insertMemory(makeMemory("new-002"));
    const result = await env.sync.push();
    expect(result.pushed).toBe(2);
    expect(result.errors).toEqual([]);
    expect(env.remoteDb.getMemory("new-001")).not.toBeNull();
    expect(env.remoteDb.getMemory("new-002")).not.toBeNull();
  });

  it("pushes locally-modified memory when remote unchanged", async () => {
    const initial = makeMemory("shared-001", { modified: "2026-01-01T00:00:00Z" });
    env.localDb.insertMemory(initial);
    env.remoteDb.insertMemory(initial);
    env.localDb.setMeta("remote_last_synced_at", "2026-01-02T00:00:00Z");

    // Modify local
    const updated = { ...initial, title: "Updated", modified: "2026-01-03T00:00:00Z" };
    env.localDb.insertMemory(updated);

    const result = await env.sync.push();
    expect(result.pushed).toBe(1);
    expect(env.remoteDb.getMemory("shared-001")?.title).toBe("Updated");
  });
});

describe("RemoteSync.pull", () => {
  let env: SyncEnv;
  beforeEach(async () => { env = await createSyncEnv(); });
  afterEach(async () => { await cleanupSyncEnv(env); });

  it("pulls new remote memories to local", async () => {
    env.remoteDb.insertMemory(makeMemory("rem-001"));
    env.remoteDb.insertMemory(makeMemory("rem-002"));
    const result = await env.sync.pull();
    expect(result.pulled).toBe(2);
    expect(env.localDb.getMemory("rem-001")).not.toBeNull();
    expect(env.localDb.getMemory("rem-002")).not.toBeNull();
  });

  it("pulls remotely-modified memory when local unchanged", async () => {
    const initial = makeMemory("shared-002", { modified: "2026-01-01T00:00:00Z" });
    env.localDb.insertMemory(initial);
    env.remoteDb.insertMemory(initial);
    env.localDb.setMeta("remote_last_synced_at", "2026-01-02T00:00:00Z");

    const updated = { ...initial, title: "Remote Updated", modified: "2026-01-03T00:00:00Z" };
    env.remoteDb.insertMemory(updated);

    const result = await env.sync.pull();
    expect(result.pulled).toBe(1);
    expect(env.localDb.getMemory("shared-002")?.title).toBe("Remote Updated");
  });
});

describe("RemoteSync conflict detection", () => {
  let env: SyncEnv;
  beforeEach(async () => { env = await createSyncEnv(); });
  afterEach(async () => { await cleanupSyncEnv(env); });

  it("flags conflict when both sides modified the same memory", async () => {
    const initial = makeMemory("shared-003", { modified: "2026-01-01T00:00:00Z" });
    env.localDb.insertMemory(initial);
    env.remoteDb.insertMemory(initial);
    env.localDb.setMeta("remote_last_synced_at", "2026-01-02T00:00:00Z");

    // Both sides modify after last sync
    env.localDb.insertMemory({ ...initial, title: "Local Edit", modified: "2026-01-03T10:00:00Z" });
    env.remoteDb.insertMemory({ ...initial, title: "Remote Edit", modified: "2026-01-03T11:00:00Z" });

    const result = await env.sync.push({ strategy: "skip-and-flag" });
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].memoryId).toBe("shared-003");
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const unresolved = env.localDb.getUnresolvedConflicts();
    expect(unresolved.length).toBe(1);
  });

  it("newer-wins strategy auto-resolves conflicts", async () => {
    const initial = makeMemory("shared-004", { modified: "2026-01-01T00:00:00Z" });
    env.localDb.insertMemory(initial);
    env.remoteDb.insertMemory(initial);
    env.localDb.setMeta("remote_last_synced_at", "2026-01-02T00:00:00Z");

    env.localDb.insertMemory({ ...initial, title: "Local Edit", modified: "2026-01-03T10:00:00Z" });
    env.remoteDb.insertMemory({ ...initial, title: "Remote Edit", modified: "2026-01-03T11:00:00Z" });

    const result = await env.sync.sync({ strategy: "newer-wins" });
    // Remote was newer, so it should win
    expect(result.conflicts.length).toBe(0);
    expect(env.localDb.getMemory("shared-004")?.title).toBe("Remote Edit");
  });
});

describe("RemoteSync.resolve", () => {
  let env: SyncEnv;
  beforeEach(async () => { env = await createSyncEnv(); });
  afterEach(async () => { await cleanupSyncEnv(env); });

  it("keeps local version on resolve(local)", async () => {
    const initial = makeMemory("resolve-001", { modified: "2026-01-01T00:00:00Z" });
    env.localDb.insertMemory({ ...initial, title: "Local", modified: "2026-01-03T00:00:00Z" });
    env.remoteDb.insertMemory({ ...initial, title: "Remote", modified: "2026-01-03T01:00:00Z" });
    env.localDb.recordConflict("resolve-001", "2026-01-03T00:00:00Z", "2026-01-03T01:00:00Z");

    const result = await env.sync.resolve("resolve-001", "local");
    expect(result.ok).toBe(true);
    expect(env.localDb.getMemory("resolve-001")?.title).toBe("Local");
    expect(env.remoteDb.getMemory("resolve-001")?.title).toBe("Local");
    expect(env.localDb.getUnresolvedConflicts().length).toBe(0);
  });

  it("keeps remote version on resolve(remote)", async () => {
    const initial = makeMemory("resolve-002", { modified: "2026-01-01T00:00:00Z" });
    env.localDb.insertMemory({ ...initial, title: "Local", modified: "2026-01-03T00:00:00Z" });
    env.remoteDb.insertMemory({ ...initial, title: "Remote", modified: "2026-01-03T01:00:00Z" });
    env.localDb.recordConflict("resolve-002", "2026-01-03T00:00:00Z", "2026-01-03T01:00:00Z");

    const result = await env.sync.resolve("resolve-002", "remote");
    expect(result.ok).toBe(true);
    expect(env.localDb.getMemory("resolve-002")?.title).toBe("Remote");
    expect(env.remoteDb.getMemory("resolve-002")?.title).toBe("Remote");
  });
});

describe("RemoteSync.migrate", () => {
  let env: SyncEnv;
  beforeEach(async () => { env = await createSyncEnv(); });
  afterEach(async () => { await cleanupSyncEnv(env); });

  it("copies all local memories to a fresh remote", async () => {
    env.localDb.insertMemory(makeMemory("m-001"));
    env.localDb.insertMemory(makeMemory("m-002"));
    env.localDb.insertMemory(makeMemory("m-003"));

    const result = await env.sync.migrate();
    expect(result.ok).toBe(true);
    expect(result.copied).toBe(3);
    expect(env.remoteDb.getMemory("m-001")).not.toBeNull();
    expect(env.remoteDb.getMemory("m-003")).not.toBeNull();
  });
});

describe("RemoteSync.sync (full cycle)", () => {
  let env: SyncEnv;
  beforeEach(async () => { env = await createSyncEnv(); });
  afterEach(async () => { await cleanupSyncEnv(env); });

  it("two-way sync: local push and remote pull happen in one call", async () => {
    env.localDb.insertMemory(makeMemory("local-only"));
    env.remoteDb.insertMemory(makeMemory("remote-only"));

    const result = await env.sync.sync();
    expect(result.pushed).toBeGreaterThanOrEqual(1);
    expect(result.pulled).toBeGreaterThanOrEqual(1);

    // After sync, both sides have both memories
    expect(env.localDb.getMemory("remote-only")).not.toBeNull();
    expect(env.remoteDb.getMemory("local-only")).not.toBeNull();

    // Last sync timestamp updated
    expect(env.localDb.getMeta("remote_last_synced_at")).not.toBeNull();
  });
});

describe("getMachineId", () => {
  it("generates and persists a stable machine ID", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-machine-"));
    try {
      const db = new GnosysDB(tmp);
      const id1 = getMachineId(db);
      const id2 = getMachineId(db);
      expect(id1).toBe(id2);
      expect(id1.length).toBeGreaterThan(0);
      db.close();
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("formatStatus", () => {
  it("formats unconfigured status", () => {
    const text = formatStatus({
      configured: false,
      reachable: false,
      lastSync: null,
      pendingPush: 0,
      pendingPull: 0,
      queuedWrites: 0,
      conflicts: [],
    });
    expect(text).toContain("not configured");
  });

  it("formats unreachable status", () => {
    const text = formatStatus({
      configured: true,
      reachable: false,
      remotePath: "/Volumes/test",
      lastSync: null,
      pendingPush: 0,
      pendingPull: 0,
      queuedWrites: 0,
      conflicts: [],
    });
    expect(text).toContain("unreachable");
  });

  it("formats normal status with counts", () => {
    const text = formatStatus({
      configured: true,
      reachable: true,
      remotePath: "/Volumes/test",
      lastSync: "2026-04-08T00:00:00Z",
      pendingPush: 3,
      pendingPull: 1,
      queuedWrites: 0,
      conflicts: [],
    });
    expect(text).toContain("Pending push: 3");
    expect(text).toContain("Pending pull: 1");
  });
});
