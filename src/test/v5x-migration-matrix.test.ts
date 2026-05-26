/**
 * v5.x migration matrix — every supported old schema version → current (v4).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { GnosysDB } from "../lib/db.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-migrate-matrix-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const MEMORY_ROW = {
  id: "deci-001",
  title: "Test decision",
  category: "decisions",
  content: "Migration test content",
  summary: null,
  tags: "[]",
  relevance: "migration",
  author: "human+ai",
  authority: "declared",
  confidence: 0.9,
  reinforcement_count: 0,
  content_hash: "migrate-hash",
  status: "active",
  tier: "active",
  supersedes: null,
  superseded_by: null,
  last_reinforced: null,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-02T00:00:00.000Z",
  embedding: null,
  source_path: null,
};

function seedV1(dbFile: string): void {
  const raw = new Database(dbFile);
  raw.exec(`
    CREATE TABLE memories (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL,
      category            TEXT NOT NULL,
      content             TEXT NOT NULL,
      summary             TEXT,
      tags                TEXT DEFAULT '',
      relevance           TEXT DEFAULT '',
      author              TEXT NOT NULL DEFAULT 'ai',
      authority           TEXT NOT NULL DEFAULT 'imported',
      confidence          REAL DEFAULT 0.8,
      reinforcement_count INTEGER DEFAULT 0,
      content_hash        TEXT NOT NULL,
      status              TEXT DEFAULT 'active',
      tier                TEXT DEFAULT 'active',
      supersedes          TEXT,
      superseded_by       TEXT,
      last_reinforced     TEXT,
      created             TEXT NOT NULL,
      modified            TEXT NOT NULL,
      embedding           BLOB,
      source_path         TEXT
    );
    CREATE TABLE audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT NOT NULL,
      operation   TEXT NOT NULL,
      memory_id   TEXT,
      details     TEXT,
      duration_ms INTEGER,
      trace_id    TEXT
    );
  `);
  raw.prepare(`
    INSERT INTO memories (
      id, title, category, content, summary, tags, relevance, author, authority,
      confidence, reinforcement_count, content_hash, status, tier, supersedes,
      superseded_by, last_reinforced, created, modified, embedding, source_path
    ) VALUES (
      @id, @title, @category, @content, @summary, @tags, @relevance, @author, @authority,
      @confidence, @reinforcement_count, @content_hash, @status, @tier, @supersedes,
      @superseded_by, @last_reinforced, @created, @modified, @embedding, @source_path
    )
  `).run(MEMORY_ROW);
  raw.pragma("user_version = 1");
  raw.close();
}

function seedV2(dbFile: string): void {
  seedV1(dbFile);
  const raw = new Database(dbFile);
  raw.exec(`
    ALTER TABLE memories ADD COLUMN project_id TEXT;
    ALTER TABLE memories ADD COLUMN scope TEXT DEFAULT 'project';
    CREATE TABLE projects (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      working_directory   TEXT NOT NULL UNIQUE,
      user                TEXT NOT NULL,
      agent_rules_target  TEXT,
      obsidian_vault      TEXT,
      created             TEXT NOT NULL,
      modified            TEXT NOT NULL
    );
  `);
  raw.prepare(
    "INSERT INTO projects (id,name,working_directory,user,created,modified) VALUES (?,?,?,?,?,?)",
  ).run("proj-1", "Matrix Project", "/tmp/matrix-project", "edward", "2026-01-01", "2026-01-01");
  raw.prepare("UPDATE memories SET project_id = ?, scope = ? WHERE id = ?").run("proj-1", "project", MEMORY_ROW.id);
  raw.pragma("user_version = 2");
  raw.close();
}

function assertMigratedToV4(dir: string, opts: { projectId?: string | null } = {}): void {
  const dbFile = path.join(dir, "gnosys.db");
  const raw = new Database(dbFile);
  expect(raw.pragma("user_version", { simple: true })).toBe(4);

  const mcols = (raw.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
  expect(mcols).toEqual(expect.arrayContaining([
    "project_id",
    "scope",
    "source_file",
    "source_page",
    "source_timerange",
  ]));

  const pcols = (raw.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name);
  expect(pcols).toEqual(expect.arrayContaining(["root_id", "rel_path"]));

  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name);
  expect(tables).toContain("project_locations");

  const mem = raw.prepare("SELECT title, project_id, scope FROM memories WHERE id = ?").get(MEMORY_ROW.id) as {
    title: string;
    project_id: string | null;
    scope: string | null;
  };
  expect(mem.title).toBe(MEMORY_ROW.title);
  if (opts.projectId !== undefined) {
    expect(mem.project_id ?? null).toBe(opts.projectId);
  }
  expect(mem.scope).toBe("project");

  if (opts.projectId) {
    const project = raw.prepare("SELECT name FROM projects WHERE id = ?").get(opts.projectId) as { name: string } | undefined;
    expect(project?.name).toBe("Matrix Project");
  }

  raw.close();
}

describe("v5.x migration matrix", () => {
  it("migrates a v1 DB to current (user_version=4)", () => {
    seedV1(path.join(tmp, "gnosys.db"));
    const db = new GnosysDB(tmp);
    db.close();
    assertMigratedToV4(tmp, { projectId: null });
  });

  it("migrates a v2 DB to current (user_version=4)", () => {
    seedV2(path.join(tmp, "gnosys.db"));
    const db = new GnosysDB(tmp);
    db.close();
    assertMigratedToV4(tmp, { projectId: "proj-1" });
  });
});
