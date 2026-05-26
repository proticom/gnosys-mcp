/**
 * Two-machine remote sync simulation — A ↔ NAS ↔ B round-trip with conflict.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { GnosysDB, type DbMemory } from "../lib/db.js";
import { RemoteSync } from "../lib/remote.js";

const MEM_ID = "two-machine-001";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";
const T3 = "2026-01-04T12:00:00.000Z";
const T4 = "2026-01-04T13:00:00.000Z";
const META_LAST_SYNC = "remote_last_synced_at";

function makeMemory(content: string, modified: string): DbMemory {
  return {
    id: MEM_ID,
    title: "Two-machine memory",
    category: "decisions",
    content,
    summary: null,
    tags: '["sync","test"]',
    relevance: "two machine sync test",
    author: "human+ai",
    authority: "declared",
    confidence: 0.9,
    reinforcement_count: 0,
    content_hash: "sync-test-hash",
    status: "active",
    tier: "active",
    supersedes: null,
    superseded_by: null,
    last_reinforced: null,
    created: T0,
    modified,
    embedding: null,
    source_path: null,
    source_file: null,
    source_page: null,
    source_timerange: null,
    project_id: null,
    scope: "project",
  } as DbMemory;
}

interface TwoMachineEnv {
  dirA: string;
  dirB: string;
  nasDir: string;
  dbA: GnosysDB;
  dbB: GnosysDB;
  nasDb: GnosysDB;
  syncA: RemoteSync;
  syncB: RemoteSync;
}

function createTwoMachineEnv(): TwoMachineEnv {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-2m-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-2m-b-"));
  const nasDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-2m-nas-"));
  const dbA = new GnosysDB(dirA);
  const dbB = new GnosysDB(dirB);
  const nasDb = new GnosysDB(nasDir);
  const syncA = new RemoteSync(dbA, nasDir);
  const syncB = new RemoteSync(dbB, nasDir);
  return { dirA, dirB, nasDir, dbA, dbB, nasDb, syncA, syncB };
}

async function cleanupTwoMachineEnv(env: TwoMachineEnv): Promise<void> {
  env.syncA.closeRemote();
  env.syncB.closeRemote();
  env.dbA.close();
  env.dbB.close();
  env.nasDb.close();
  await fsp.rm(env.dirA, { recursive: true, force: true });
  await fsp.rm(env.dirB, { recursive: true, force: true });
  await fsp.rm(env.nasDir, { recursive: true, force: true });
}

describe("two-machine remote sync simulation", () => {
  let env: TwoMachineEnv;

  beforeEach(() => {
    env = createTwoMachineEnv();
  });

  afterEach(async () => {
    await cleanupTwoMachineEnv(env);
  });

  it("A→NAS→B round-trip with conflict loses no data", async () => {
    // 1. Machine A creates a memory and pushes to NAS.
    env.dbA.insertMemory(makeMemory("v1-from-A", T0));
    const pushA1 = await env.syncA.push();
    expect(pushA1.errors).toEqual([]);
    expect(pushA1.pushed).toBe(1);
    env.dbA.setMeta(META_LAST_SYNC, T0);
    expect(env.nasDb.getMemory(MEM_ID)?.content).toContain("v1-from-A");

    // 2. Machine B pulls and receives A's memory.
    const pullB1 = await env.syncB.pull();
    expect(pullB1.errors).toEqual([]);
    expect(pullB1.pulled).toBe(1);
    env.dbB.setMeta(META_LAST_SYNC, T0);
    expect(env.dbB.getMemory(MEM_ID)?.content).toContain("v1-from-A");

    // 3. Machine B edits and pushes back to NAS.
    env.dbB.insertMemory(makeMemory("v2-from-B", T1));
    const pushB1 = await env.syncB.push();
    expect(pushB1.errors).toEqual([]);
    expect(pushB1.pushed).toBe(1);
    env.dbB.setMeta(META_LAST_SYNC, T1);
    expect(env.nasDb.getMemory(MEM_ID)?.content).toContain("v2-from-B");

    // 4. Machine A pulls and receives B's edit.
    env.dbA.setMeta(META_LAST_SYNC, T0);
    const pullA1 = await env.syncA.pull();
    expect(pullA1.errors).toEqual([]);
    expect(pullA1.pulled).toBe(1);
    env.dbA.setMeta(META_LAST_SYNC, T1);
    expect(env.dbA.getMemory(MEM_ID)?.content).toContain("v2-from-B");

    // 5. Both machines edit offline; B pushes; A syncs and flags a conflict.
    env.dbA.setMeta(META_LAST_SYNC, T2);
    env.dbB.setMeta(META_LAST_SYNC, T2);
    env.dbA.insertMemory(makeMemory("v3-from-A", T4));
    env.dbB.insertMemory(makeMemory("v3-from-B", T3));

    const pushB2 = await env.syncB.push({ strategy: "skip-and-flag" });
    expect(pushB2.errors).toEqual([]);
    expect(pushB2.pushed).toBe(1);
    expect(env.nasDb.getMemory(MEM_ID)?.content).toContain("v3-from-B");

    const syncA = await env.syncA.sync({ strategy: "skip-and-flag" });
    expect(syncA.errors).toEqual([]);
    expect(syncA.conflicts.length).toBe(1);
    expect(syncA.conflicts[0].memoryId).toBe(MEM_ID);

    const unresolved = env.dbA.getUnresolvedConflicts();
    expect(unresolved.length).toBe(1);
    expect(unresolved[0].memory_id).toBe(MEM_ID);

    // No silent data loss: both sides still hold their memory; A keeps its local version pending resolve.
    expect(env.dbA.getMemory(MEM_ID)).not.toBeNull();
    expect(env.dbA.getMemory(MEM_ID)?.content).toContain("v3-from-A");
    expect(env.dbB.getMemory(MEM_ID)).not.toBeNull();
    expect(env.dbB.getMemory(MEM_ID)?.content).toContain("v3-from-B");
    expect(env.nasDb.getMemory(MEM_ID)).not.toBeNull();
    expect(env.nasDb.getMemory(MEM_ID)?.content).toContain("v3-from-B");
  });
});
