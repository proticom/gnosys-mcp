/**
 * Export archive visibility — excluded archived count + flagged export when included.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GnosysDB } from "../lib/db.js";
import { exportProject } from "../lib/exportProject.js";
import { readBundle } from "../lib/importProject.js";
import { GnosysExporter } from "../lib/export.js";

function makeDb(): { db: GnosysDB; tmp: string } {
  const tmp = mkdtempSync(join(tmpdir(), "gnosys-export-archive-"));
  const db = new GnosysDB(tmp);
  return { db, tmp };
}

function seedProject(db: GnosysDB, projectId: string, count: number): string[] {
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
    const id = `mem-arch-${i.toString().padStart(3, "0")}`;
    ids.push(id);
    db.insertMemory({
      id,
      title: `Memory ${i}`,
      category: "test",
      content: `Content ${i}`,
      summary: null,
      tags: "[]",
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

describe("export archive visibility", () => {
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

  it("default exportProject reports archivedExcluded and omits archived memories", () => {
    const projectId = "proj-archive-report";
    const ids = seedProject(workspace.db, projectId, 5);
    workspace.db.updateMemory(ids[0], { status: "archived" });
    workspace.db.updateMemory(ids[1], { tier: "archive" });

    const result = exportProject(workspace.db, {
      projectId,
      outputPath: bundlePath,
      includeArchived: false,
    });

    expect(result.memoryCount).toBe(3);
    expect(result.archivedExcluded).toBe(2);

    const bundle = readBundle(bundlePath);
    expect(bundle.memories).toHaveLength(3);
  });

  it("includeArchived exports all with status preserved and archivedExcluded 0", () => {
    const projectId = "proj-archive-full";
    const ids = seedProject(workspace.db, projectId, 4);
    workspace.db.updateMemory(ids[0], { status: "archived" });
    workspace.db.updateMemory(ids[1], { tier: "archive" });

    const result = exportProject(workspace.db, {
      projectId,
      outputPath: bundlePath,
      includeArchived: true,
    });

    expect(result.memoryCount).toBe(4);
    expect(result.archivedExcluded).toBe(0);

    const bundle = readBundle(bundlePath);
    expect(bundle.memories).toHaveLength(4);
    const archived = bundle.memories.filter((m) => m.status === "archived");
    expect(archived.length).toBeGreaterThanOrEqual(1);
  });

  it("vault export activeOnly reports archivedExcluded", async () => {
    const ids = seedProject(workspace.db, "proj-vault", 3);
    workspace.db.updateMemory(ids[0], { status: "archived" });

    const exporter = new GnosysExporter(workspace.db);
    const report = await exporter.export({
      targetDir: join(workspace.tmp, "vault-out"),
      activeOnly: true,
    });

    expect(report.memoriesExported).toBe(2);
    expect(report.archivedExcluded).toBe(1);
  });
});
