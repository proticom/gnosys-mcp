/**
 * v5.11 — machine-aware project path resolution.
 *
 * Verifies override > root > none priority, "not on this machine" handling,
 * and the recordLocation write-path (root vs override selection).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveProjectPath,
  resolveProject,
  resolveAllProjects,
  recordLocation,
} from "../lib/projectPaths.js";
import type { MachineConfig } from "../lib/machineConfig.js";
import type { DbProject } from "../lib/db.js";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "./_helpers.js";

const STUDIO: MachineConfig = {
  machineId: "studio-id",
  hostname: "studio",
  roots: { dev: "/Users/edward/MSDev/projects" },
  remote: { enabled: false },
  schemaVersion: 1,
};

// Local builder: the shared makeProject() predates root_id/rel_path and drops
// them, so build full DbProject objects here.
function mkProj(o: Partial<DbProject>): DbProject {
  const now = new Date().toISOString();
  return {
    id: "p", name: "P", working_directory: "", root_id: null, rel_path: null,
    user: "u", agent_rules_target: null, obsidian_vault: null, created: now, modified: now,
    ...o,
  };
}

let env: TestEnv;
beforeEach(async () => {
  env = await createTestEnv("v511-paths");
});
afterEach(async () => {
  await cleanupTestEnv(env);
});

describe("v5.11 resolveProjectPath", () => {
  it("resolves via root_id + rel_path against this machine's root", () => {
    env.db.insertProject(mkProj({ id: "p1", name: "gnosys-ai", root_id: "dev", rel_path: "gnosys-ai" }));
    expect(resolveProjectPath(env.db, STUDIO, "p1")).toBe("/Users/edward/MSDev/projects/gnosys-ai");
  });

  it("prefers a per-machine override over the root resolution", () => {
    env.db.insertProject(mkProj({ id: "p1", name: "gnosys-ai", root_id: "dev", rel_path: "gnosys-ai" }));
    env.db.setProjectLocation({ project_id: "p1", machine_id: "studio-id", abs_path: "/custom/override/path", modified: new Date().toISOString() });
    expect(resolveProjectPath(env.db, STUDIO, "p1")).toBe("/custom/override/path");
  });

  it("returns null when the project's root isn't configured on this machine", () => {
    env.db.insertProject(mkProj({ id: "p1", name: "x", root_id: "work", rel_path: "x" }));
    expect(resolveProjectPath(env.db, STUDIO, "p1")).toBeNull();
  });

  it("returns null for an unknown project", () => {
    expect(resolveProjectPath(env.db, STUDIO, "nope")).toBeNull();
  });
});

describe("v5.11 resolveProject / resolveAllProjects", () => {
  it("reports provenance per project", () => {
    env.db.insertProject(mkProj({ id: "root1", name: "A", root_id: "dev", rel_path: "a" }));
    env.db.insertProject(mkProj({ id: "ov1", name: "B" }));
    env.db.setProjectLocation({ project_id: "ov1", machine_id: "studio-id", abs_path: "/outside/b", modified: new Date().toISOString() });
    env.db.insertProject(mkProj({ id: "gone", name: "C", root_id: "work", rel_path: "c" }));

    expect(resolveProject(env.db, STUDIO, "root1")?.source).toBe("root");
    expect(resolveProject(env.db, STUDIO, "ov1")?.source).toBe("override");
    const gone = resolveProject(env.db, STUDIO, "gone");
    expect(gone?.source).toBe("none");
    expect(gone?.absPath).toBeNull();
    expect(resolveProject(env.db, STUDIO, "missing")).toBeNull();

    const all = resolveAllProjects(env.db, STUDIO);
    expect(all.length).toBe(3);
    expect(all.filter((r) => r.absPath === null).length).toBe(1);
  });
});

describe("v5.11 recordLocation", () => {
  it("stores machine-independent root_id+rel_path when path is under a root", () => {
    env.db.insertProject(mkProj({ id: "p1", name: "gnosys-ai" }));
    const res = recordLocation(env.db, STUDIO, "p1", "/Users/edward/MSDev/projects/gnosys-ai/gnosys-public");
    expect(res.mode).toBe("root");
    expect(res.rootId).toBe("dev");
    expect(res.relPath).toBe("gnosys-ai/gnosys-public");

    const p = env.db.getProject("p1");
    expect(p?.root_id).toBe("dev");
    expect(p?.rel_path).toBe("gnosys-ai/gnosys-public");
    expect(env.db.getProjectLocation("p1", "studio-id")).toBeNull();
  });

  it("stores a per-machine override when path is outside every root", () => {
    env.db.insertProject(mkProj({ id: "p2", name: "outlier" }));
    const res = recordLocation(env.db, STUDIO, "p2", "/Users/edward/Documents/outlier");
    expect(res.mode).toBe("override");
    expect(env.db.getProjectLocation("p2", "studio-id")?.abs_path).toBe("/Users/edward/Documents/outlier");
    expect(resolveProjectPath(env.db, STUDIO, "p2")).toBe("/Users/edward/Documents/outlier");
  });

  it("clears a redundant override once a project moves under a root", () => {
    env.db.insertProject(mkProj({ id: "p3", name: "moved" }));
    recordLocation(env.db, STUDIO, "p3", "/tmp/elsewhere/moved");
    expect(env.db.getProjectLocation("p3", "studio-id")).not.toBeNull();
    const res = recordLocation(env.db, STUDIO, "p3", "/Users/edward/MSDev/projects/moved");
    expect(res.mode).toBe("root");
    expect(env.db.getProjectLocation("p3", "studio-id")).toBeNull();
  });
});
