/**
 * Phase 1 — per-project bundle export/import round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GnosysDB } from "../lib/db.js";
import { exportProject } from "../lib/exportProject.js";
import { importProject, readBundle } from "../lib/importProject.js";

function makeDb(): { db: GnosysDB; tmp: string } {
  const tmp = mkdtempSync(join(tmpdir(), "gnosys-bundle-test-"));
  const db = new GnosysDB(tmp);
  return { db, tmp };
}

function seed(db: GnosysDB, projectId: string, count: number): string[] {
  db.insertProject({
    id: projectId,
    name: "test-project",
    working_directory: "/tmp/test",
    user: "tester",
    agent_rules_target: null,
    obsidian_vault: null,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
  });

  const ids: string[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const id = `mem-test-${i.toString().padStart(3, "0")}`;
    ids.push(id);
    db.insertMemory({
      id,
      title: `Test memory ${i}`,
      category: "test",
      content: `Content of memory ${i}`,
      summary: null,
      tags: '["test"]',
      relevance: "test",
      author: "ai",
      authority: "imported",
      confidence: 0.8,
      reinforcement_count: 0,
      content_hash: `hash-${i}`,
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
      project_id: projectId,
      scope: "project",
    });
  }
  return ids;
}

describe("project bundle round-trip", () => {
  let workspace: { db: GnosysDB; tmp: string };
  let bundlePath: string;

  beforeEach(() => {
    workspace = makeDb();
    bundlePath = join(workspace.tmp, "bundle.json.gz");
  });

  afterEach(() => {
    workspace.db.close();
    rmSync(workspace.tmp, { recursive: true, force: true });
  });

  it("exports a project to a .json.gz bundle", () => {
    const projectId = "proj-test-001";
    seed(workspace.db, projectId, 5);

    const result = exportProject(workspace.db, {
      projectId,
      outputPath: bundlePath,
    });

    expect(result.memoryCount).toBe(5);
    expect(result.compressedBytes).toBeGreaterThan(0);
    expect(result.compressedBytes).toBeLessThan(result.uncompressedBytes);
    expect(existsSync(bundlePath)).toBe(true);
  });

  it("readBundle round-trips the manifest, project, and memories", () => {
    const projectId = "proj-test-002";
    seed(workspace.db, projectId, 3);
    exportProject(workspace.db, { projectId, outputPath: bundlePath });

    const bundle = readBundle(bundlePath);
    expect(bundle.manifest.format).toBe("gnosys-project-bundle");
    expect(bundle.manifest.version).toBe(1);
    expect(bundle.project.id).toBe(projectId);
    expect(bundle.project.name).toBe("test-project");
    expect(bundle.memories).toHaveLength(3);
    expect(bundle.memories[0].title).toMatch(/Test memory/);
  });

  it("import strategy=merge skips existing memories", () => {
    const projectId = "proj-merge";
    seed(workspace.db, projectId, 4);
    exportProject(workspace.db, { projectId, outputPath: bundlePath });

    // Re-import on the same DB (project + memories already exist) — should skip
    const result = importProject(workspace.db, {
      bundlePath,
      strategy: "merge",
    });

    expect(result.memoriesInserted).toBe(0);
    expect(result.memoriesSkipped).toBe(4);
    expect(result.memoriesReplaced).toBe(0);
  });

  it("import strategy=new-id remaps the project ID and memory IDs", () => {
    const projectId = "proj-newid";
    seed(workspace.db, projectId, 3);
    exportProject(workspace.db, { projectId, outputPath: bundlePath });

    const result = importProject(workspace.db, {
      bundlePath,
      strategy: "new-id",
    });

    expect(result.projectId).not.toBe(projectId);
    expect(result.projectId).toContain(projectId);
    expect(result.memoriesInserted).toBe(3);
    expect(result.memoriesSkipped).toBe(0);

    // Original project's memories still intact
    expect(workspace.db.getMemoriesByProject(projectId)).toHaveLength(3);
    // New project has its own copy
    expect(workspace.db.getMemoriesByProject(result.projectId)).toHaveLength(3);
  });

  it("import strategy=replace deletes existing project memories", () => {
    const projectId = "proj-replace";
    seed(workspace.db, projectId, 2);
    exportProject(workspace.db, { projectId, outputPath: bundlePath });

    // Add an extra memory NOT in the bundle
    const now = new Date().toISOString();
    workspace.db.insertMemory({
      id: "mem-extra",
      title: "Extra memory",
      category: "test",
      content: "Should be wiped on replace",
      summary: null,
      tags: "[]",
      relevance: "",
      author: "ai",
      authority: "imported",
      confidence: 0.5,
      reinforcement_count: 0,
      content_hash: "extra-hash",
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
      project_id: projectId,
      scope: "project",
    });
    expect(workspace.db.getMemoriesByProject(projectId)).toHaveLength(3);

    const result = importProject(workspace.db, {
      bundlePath,
      strategy: "replace",
    });

    expect(result.memoriesReplaced).toBeGreaterThanOrEqual(2); // Old memories wiped
    expect(result.memoriesInserted).toBe(2);                    // Bundle re-imported
    expect(workspace.db.getMemoriesByProject(projectId)).toHaveLength(2);
    expect(workspace.db.getMemory("mem-extra")).toBeNull();
  });

  it("readBundle rejects malformed bundles", () => {
    const badPath = join(workspace.tmp, "bad.json.gz");
    // Write something that's not a valid gnosys bundle
    const { gzipSync } = require("zlib");
    const { writeFileSync } = require("fs");
    writeFileSync(badPath, gzipSync(Buffer.from(JSON.stringify({ hello: "world" }))));

    expect(() => readBundle(badPath)).toThrow(/Not a Gnosys project bundle/);
  });

  it("export with includeArchived=false skips archived memories", () => {
    const projectId = "proj-archived";
    const ids = seed(workspace.db, projectId, 4);
    // Archive 2 of them
    workspace.db.updateMemory(ids[0], { tier: "archive" });
    workspace.db.updateMemory(ids[1], { status: "archived" });

    exportProject(workspace.db, { projectId, outputPath: bundlePath, includeArchived: false });
    const bundle = readBundle(bundlePath);
    expect(bundle.memories).toHaveLength(2);

    exportProject(workspace.db, { projectId, outputPath: bundlePath, includeArchived: true });
    const bundleAll = readBundle(bundlePath);
    expect(bundleAll.memories).toHaveLength(4);
  });
});
