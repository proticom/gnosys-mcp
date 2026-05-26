/**
 * v5.12 sync audit — push/pull emit audit rows for observability.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { GnosysDB, type DbMemory } from "../lib/db.js";
import { RemoteSync } from "../lib/remote.js";

function makeMemory(id: string, overrides: Partial<DbMemory> = {}): DbMemory {
  const now = new Date().toISOString();
  return {
    id,
    title: `Memory ${id}`,
    category: "decisions",
    content: `Content of ${id}`,
    summary: null,
    tags: '["test"]',
    relevance: "sync audit test",
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
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-sync-audit-local-"));
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-sync-audit-remote-"));
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

describe("v5.12 sync audit rows", () => {
  let env: SyncEnv;

  beforeEach(async () => {
    env = await createSyncEnv();
  });

  afterEach(async () => {
    await cleanupSyncEnv(env);
  });

  it("push emits a remote_push audit row with counts", async () => {
    env.localDb.insertMemory(makeMemory("audit-push-001"));
    const result = await env.sync.push();
    expect(result.pushed).toBe(1);

    const entries = env.localDb.getAuditEntriesAfter("1970-01-01T00:00:00Z");
    const pushAudit = entries.find((e) => e.operation === "remote_push");
    expect(pushAudit).toBeDefined();
    expect(JSON.parse(pushAudit!.details!)).toEqual({
      pushed: 1,
      skipped: 0,
      conflicts: 0,
    });
  });

  it("pull emits a remote_pull audit row with counts", async () => {
    env.remoteDb.insertMemory(makeMemory("audit-pull-001"));
    const result = await env.sync.pull();
    expect(result.pulled).toBe(1);

    const entries = env.localDb.getAuditEntriesAfter("1970-01-01T00:00:00Z");
    const pullAudit = entries.find((e) => e.operation === "remote_pull");
    expect(pullAudit).toBeDefined();
    expect(JSON.parse(pullAudit!.details!)).toEqual({
      pulled: 1,
      skipped: 0,
      conflicts: 0,
    });
  });

  it("sync emits both remote_push and remote_pull audit rows", async () => {
    env.localDb.insertMemory(makeMemory("audit-sync-local"));
    env.remoteDb.insertMemory(makeMemory("audit-sync-remote"));
    await env.sync.sync();

    const ops = env.localDb
      .getAuditEntriesAfter("1970-01-01T00:00:00Z")
      .map((e) => e.operation);
    expect(ops).toContain("remote_push");
    expect(ops).toContain("remote_pull");
  });
});
