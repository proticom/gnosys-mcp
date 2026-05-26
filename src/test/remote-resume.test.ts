/**
 * Remote push resume — interrupted push leaves no partial state; re-push completes idempotently.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { GnosysDB, type DbMemory } from "../lib/db.js";
import { RemoteSync } from "../lib/remote.js";

const META_LAST_SYNC = "remote_last_synced_at";
const T0 = "2026-01-01T00:00:00.000Z";
const MEMORY_COUNT = 12;
const PARTIAL_PUSH_COUNT = 5;

function sqlite(db: GnosysDB) {
  return (db as unknown as {
    db: { pragma: (s: string, opts?: { simple: boolean }) => unknown };
  }).db;
}

function makeMemory(index: number): DbMemory {
  const id = `resume-${String(index).padStart(3, "0")}`;
  const modified = `2026-01-02T00:00:${String(index).padStart(2, "0")}.000Z`;
  return {
    id,
    title: `Resume memory ${index}`,
    category: "decisions",
    content: `Content for ${id}`,
    summary: null,
    tags: '["sync","resume"]',
    relevance: "remote push resume test",
    author: "human+ai",
    authority: "declared",
    confidence: 0.9,
    reinforcement_count: 0,
    content_hash: `hash-${id}`,
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

interface ResumeEnv {
  localDir: string;
  nasDir: string;
  localDb: GnosysDB;
  nasDb: GnosysDB;
  sync: RemoteSync;
}

function createResumeEnv(): ResumeEnv {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-resume-local-"));
  const nasDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-resume-nas-"));
  const localDb = new GnosysDB(localDir);
  const nasDb = new GnosysDB(nasDir);
  const sync = new RemoteSync(localDb, nasDir);
  return { localDir, nasDir, localDb, nasDb, sync };
}

async function cleanupResumeEnv(env: ResumeEnv): Promise<void> {
  env.sync.closeRemote();
  env.localDb.close();
  env.nasDb.close();
  await fsp.rm(env.localDir, { recursive: true, force: true });
  await fsp.rm(env.nasDir, { recursive: true, force: true });
}

describe("remote push resume after interruption", () => {
  let env: ResumeEnv;

  beforeEach(() => {
    env = createResumeEnv();
  });

  afterEach(async () => {
    await cleanupResumeEnv(env);
  });

  it("resumes after simulated mid-push kill with no corruption or duplicates", async () => {
    const memories = Array.from({ length: MEMORY_COUNT }, (_, i) => makeMemory(i));
    for (const mem of memories) {
      env.localDb.insertMemory(mem);
    }
    env.localDb.setMeta(META_LAST_SYNC, T0);

    // Simulate process kill after PARTIAL_PUSH_COUNT memories reached the remote.
    for (let i = 0; i < PARTIAL_PUSH_COUNT; i++) {
      env.nasDb.insertMemory(memories[i]);
    }
    // lastSync intentionally unchanged — as if push died before updating metadata.

    const resume = await env.sync.push();
    expect(resume.errors).toEqual([]);
    expect(env.localDb.getUnresolvedConflicts()).toEqual([]);

    expect(sqlite(env.nasDb).pragma("integrity_check", { simple: true })).toBe("ok");

    const remoteIds = env.nasDb.getAllMemories().map((m) => m.id);
    expect(new Set(remoteIds).size).toBe(remoteIds.length);
    expect(remoteIds.length).toBe(MEMORY_COUNT);

    for (const mem of memories) {
      expect(env.nasDb.getMemory(mem.id)?.content).toBe(mem.content);
    }

    // Idempotent second push — nothing left to send, remote unchanged.
    const second = await env.sync.push();
    expect(second.errors).toEqual([]);
    expect(second.pushed).toBe(0);
    expect(env.nasDb.getAllMemories().length).toBe(MEMORY_COUNT);
  });
});
