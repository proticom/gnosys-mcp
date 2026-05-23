/**
 * v5.11 — DB schema for machine-portable project paths.
 *
 * Covers the v3 -> v4 migration: projects gains root_id/rel_path, the
 * UNIQUE constraint on working_directory is dropped (so the same project can
 * have different paths across machines), and the per-machine project_locations
 * override table is added.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { GnosysDB, type DbProject } from "../lib/db.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-v511db-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function project(overrides: Partial<DbProject>): DbProject {
  const now = new Date().toISOString();
  return {
    id: "p",
    name: "P",
    working_directory: "",
    user: "u",
    agent_rules_target: null,
    obsidian_vault: null,
    created: now,
    modified: now,
    ...overrides,
  };
}

describe("v5.11 schema: fresh DB", () => {
  it("persists root_id/rel_path on projects", () => {
    const db = new GnosysDB(tmp);
    db.insertProject(project({
      id: "p1", name: "gnosys-ai", working_directory: "/Users/edward/MSDev/projects/gnosys-ai",
      root_id: "dev", rel_path: "gnosys-ai",
    }));
    const got = db.getProject("p1");
    expect(got?.root_id).toBe("dev");
    expect(got?.rel_path).toBe("gnosys-ai");
    db.close();
  });

  it("allows two projects to share a working_directory (UNIQUE dropped)", () => {
    const db = new GnosysDB(tmp);
    db.insertProject(project({ id: "p1", name: "A", working_directory: "/same/path" }));
    expect(() =>
      db.insertProject(project({ id: "p2", name: "B", working_directory: "/same/path" })),
    ).not.toThrow();
    expect(db.getAllProjects().length).toBe(2);
    db.close();
  });

  it("supports per-machine project_locations CRUD", () => {
    const db = new GnosysDB(tmp);
    const now = new Date().toISOString();
    db.setProjectLocation({ project_id: "p1", machine_id: "studio", abs_path: "/Users/edward/MSDev/projects/p1", modified: now });
    db.setProjectLocation({ project_id: "p1", machine_id: "mbp", abs_path: "/Users/edward/MBPDev/projects/p1", modified: now });

    expect(db.getProjectLocation("p1", "studio")?.abs_path).toBe("/Users/edward/MSDev/projects/p1");
    expect(db.getProjectLocation("p1", "mbp")?.abs_path).toBe("/Users/edward/MBPDev/projects/p1");
    expect(db.getProjectLocation("p1", "absent")).toBeNull();
    expect(db.getProjectLocations("p1").length).toBe(2);

    // Each machine owns its row — re-setting one does not touch the other.
    db.setProjectLocation({ project_id: "p1", machine_id: "studio", abs_path: "/new/studio/path", modified: now });
    expect(db.getProjectLocation("p1", "studio")?.abs_path).toBe("/new/studio/path");
    expect(db.getProjectLocation("p1", "mbp")?.abs_path).toBe("/Users/edward/MBPDev/projects/p1");

    db.deleteProjectLocation("p1", "studio");
    expect(db.getProjectLocation("p1", "studio")).toBeNull();
    expect(db.getProjectLocations("p1").length).toBe(1);
    db.close();
  });
});

describe("v5.11 schema: migration from v3", () => {
  it("rebuilds the projects table, preserves rows, adds columns + project_locations", () => {
    // Seed an OLD (v3) DB: projects table with UNIQUE working_directory, no
    // root_id/rel_path, and user_version=3.
    const dbFile = path.join(tmp, "gnosys.db");
    const raw = new Database(dbFile);
    raw.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        working_directory TEXT NOT NULL UNIQUE,
        user TEXT NOT NULL,
        agent_rules_target TEXT,
        obsidian_vault TEXT,
        created TEXT NOT NULL,
        modified TEXT NOT NULL
      );
    `);
    raw.prepare(
      "INSERT INTO projects (id,name,working_directory,user,created,modified) VALUES (?,?,?,?,?,?)",
    ).run("legacy1", "Legacy", "/Volumes/Dev/projects/legacy", "edward", "2026-01-01", "2026-01-01");
    raw.pragma("user_version = 3");
    raw.close();

    // Opening via GnosysDB triggers the v3 -> v4 migration.
    const db = new GnosysDB(tmp);

    // Legacy row preserved, new columns present (null for legacy).
    const legacy = db.getProject("legacy1");
    expect(legacy?.working_directory).toBe("/Volumes/Dev/projects/legacy");
    expect(legacy?.root_id ?? null).toBeNull();
    expect(legacy?.rel_path ?? null).toBeNull();

    // UNIQUE is gone: inserting another project with the same dir works.
    expect(() =>
      db.insertProject(project({ id: "legacy2", name: "Legacy2", working_directory: "/Volumes/Dev/projects/legacy" })),
    ).not.toThrow();

    // New columns are writable.
    db.insertProject(project({
      id: "new1", name: "New", working_directory: "/Users/edward/MSDev/projects/new",
      root_id: "dev", rel_path: "new",
    }));
    expect(db.getProject("new1")?.rel_path).toBe("new");

    // project_locations table exists and works.
    const now = new Date().toISOString();
    db.setProjectLocation({ project_id: "legacy1", machine_id: "studio", abs_path: "/Users/edward/MSDev/projects/legacy", modified: now });
    expect(db.getProjectLocation("legacy1", "studio")?.abs_path).toBe("/Users/edward/MSDev/projects/legacy");

    db.close();
  });
});
