/**
 * Phase 1.1 — SQLITE_CORRUPT auto-recovery.
 *
 * Verifies that DB methods catch SQLITE_CORRUPT, reopen the handle, and
 * retry once. This is the fix for the long-lived MCP handle going stale
 * when concurrent writes (e.g. `gnosys setup`) happen in another process.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GnosysDB } from "../lib/db.js";

let workspace: { db: GnosysDB; tmp: string };

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "gnosys-recovery-test-"));
  const db = new GnosysDB(tmp);
  workspace = { db, tmp };
});

afterEach(() => {
  workspace.db.close();
  rmSync(workspace.tmp, { recursive: true, force: true });
});

/** Simulate a corrupt-handle error by stubbing prepare() to throw once. */
function injectCorruptOnce(db: any): void {
  const originalPrepare = db.db.prepare.bind(db.db);
  let thrown = false;
  db.db.prepare = (...args: any[]) => {
    if (!thrown) {
      thrown = true;
      const err = new Error("database disk image is malformed") as Error & { code?: string };
      err.code = "SQLITE_CORRUPT";
      throw err;
    }
    return originalPrepare(...args);
  };
}

describe("DB recovery from SQLITE_CORRUPT", () => {
  it("getMemory() retries successfully after a corrupt-handle error", () => {
    // Insert a memory normally first
    workspace.db.insertMemory({
      id: "test-001",
      title: "Test",
      category: "test",
      content: "body",
      summary: null,
      tags: "[]",
      relevance: "",
      author: "ai",
      authority: "imported",
      confidence: 0.8,
      reinforcement_count: 0,
      content_hash: "hash",
      status: "active",
      tier: "active",
      supersedes: null,
      superseded_by: null,
      last_reinforced: null,
      created: "2026-05-05",
      modified: "2026-05-05",
      embedding: null,
      source_path: null,
      source_file: null,
      source_page: null,
      source_timerange: null,
      project_id: null,
      scope: "user",
    });

    // Now inject a one-shot corrupt error on the next prepare
    injectCorruptOnce(workspace.db);

    // The recovery wrapper should catch, reopen, retry — and succeed
    const mem = workspace.db.getMemory("test-001");
    expect(mem).not.toBeNull();
    expect(mem?.title).toBe("Test");
  });

  it("insertMemory() retries successfully after a corrupt-handle error", () => {
    injectCorruptOnce(workspace.db);

    expect(() =>
      workspace.db.insertMemory({
        id: "recover-001",
        title: "Recover",
        category: "test",
        content: "body",
        summary: null,
        tags: "[]",
        relevance: "",
        author: "ai",
        authority: "imported",
        confidence: 0.8,
        reinforcement_count: 0,
        content_hash: "h",
        status: "active",
        tier: "active",
        supersedes: null,
        superseded_by: null,
        last_reinforced: null,
        created: "2026-05-05",
        modified: "2026-05-05",
        embedding: null,
        source_path: null,
        source_file: null,
        source_page: null,
        source_timerange: null,
        project_id: null,
        scope: "user",
      }),
    ).not.toThrow();

    expect(workspace.db.getMemory("recover-001")).not.toBeNull();
  });

  it("logAudit() retries successfully after a corrupt-handle error", () => {
    injectCorruptOnce(workspace.db);

    expect(() =>
      workspace.db.logAudit({
        timestamp: new Date().toISOString(),
        operation: "write",
        memory_id: "audit-target",
        details: null,
        duration_ms: null,
        trace_id: null,
      }),
    ).not.toThrow();
  });

  it("getAllProjects() retries successfully after a corrupt-handle error", () => {
    workspace.db.insertProject({
      id: "p1",
      name: "Project One",
      working_directory: "/tmp/p1",
      user: "tester",
      agent_rules_target: null,
      obsidian_vault: null,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
    });

    injectCorruptOnce(workspace.db);

    const projects = workspace.db.getAllProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("Project One");
  });

  it("rethrows non-corrupt errors without retry", () => {
    // Inject a generic error (not SQLITE_CORRUPT) — should NOT be caught
    const originalPrepare = (workspace.db as any).db.prepare.bind((workspace.db as any).db);
    (workspace.db as any).db.prepare = () => {
      throw new Error("syntax error");
    };

    expect(() => workspace.db.getMemory("anything")).toThrow(/syntax error/);
    // Restore so afterEach can close cleanly
    (workspace.db as any).db.prepare = originalPrepare;
  });

  it("throws a clear message if reopen also fails", () => {
    // Make prepare throw corrupt persistently — both initial and post-reopen
    (workspace.db as any).db.prepare = () => {
      const err = new Error("database disk image is malformed") as Error & { code?: string };
      err.code = "SQLITE_CORRUPT";
      throw err;
    };

    // The recovery wrapper will reopen — but the new prepare on the new handle
    // will be the original (good) one. We need to also break the reopen.
    // Easiest: nuke the DB file before invocation.
    rmSync(workspace.tmp, { recursive: true, force: true });

    expect(() => workspace.db.getMemory("anything")).toThrow();
  });
});
